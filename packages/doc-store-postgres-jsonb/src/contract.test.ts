import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adapterContext,
  runDocumentStoreContract,
  type DocumentStoreContractOptions,
} from '@nymbalhq/contract-tests'
import type { DocumentStoreAdapter } from '@nymbalhq/types'
import {
  createDatabase,
  postgresServerUrl,
  queryOnce,
  type TestDatabase,
} from '../../platform/tests/support/postgres'
import { closedPort } from '../../../tests/support/tcp-proxy'
import { createAdapter } from './index.js'

// P2-02 AC-2 on @nymbalhq/doc-store-postgres-jsonb (spec P2-02-primitives-are-protocols), on a fresh database on the
// composed Postgres, and P2-13 AC-2 and AC-5 (spec P2-13-contract-tests-public): runDocumentStoreContract from the
// published package runs the old cases and the reference-model property, and, given `unreachable`, the downtime cases;
// every store gets a prefix of its own. The store is built as the kernel builds it, createAdapter with the connection
// (P2-02 decision 1: the postgresUrl option, then DATABASE_URL) and initialize() (decision 5). `unreachable` is a store
// on a closed port: pg connects per query, so nothing needs to be up first. Kills, beyond the suite's: replicas that
// start together failing a boot on the table's DDL (M3).

type JsonbStore = DocumentStoreAdapter & { initialize(): Promise<void> }

let db: TestDatabase
let count = 0

beforeAll(async () => {
  db = await createDatabase(postgresServerUrl(), 'p2_02_jsonb')
})
afterAll(async () => {
  await db?.drop()
})

async function storeOn(url: string, prefix: string): Promise<JsonbStore> {
  const store = (await createAdapter(
    adapterContext('documentStore', { postgresUrl: url, prefix }, { DATABASE_URL: url }),
  )) as JsonbStore
  await store.initialize()
  return store
}

/** A store whose Postgres refuses: never initialized, since initialize() is what would reach it. */
async function unreachable(): Promise<DocumentStoreAdapter> {
  const url = `postgres://postgres:nymbal@127.0.0.1:${await closedPort()}/nymbal`
  return (await createAdapter(
    adapterContext(
      'documentStore',
      { postgresUrl: url, prefix: 'p2-13-down' },
      { DATABASE_URL: url },
    ),
  )) as DocumentStoreAdapter
}

const make = () => storeOn(db.url, `p2-02-${(count += 1)}`)
const opts: DocumentStoreContractOptions = {
  isolation: async (): Promise<[DocumentStoreAdapter, DocumentStoreAdapter]> => [
    await storeOn(db.url, `p2-02-iso-a-${(count += 1)}`),
    await storeOn(db.url, `p2-02-iso-b-${count}`),
  ],
  unreachable,
}

runDocumentStoreContract('postgres-jsonb', make, opts)

describe('P2-02 AC-2 (decision 5): Postgres JSONB owns its table', () => {
  it('AC-2: four replicas initialize() at once on a database without the table, every one succeeds, and nymbal_documents is keyed (prefix, collection, key)', async () => {
    const fresh = await createDatabase(postgresServerUrl(), 'p2_02_jsonb_race')
    const stores: JsonbStore[] = []
    try {
      for (let i = 0; i < 4; i++) {
        stores.push(
          (await createAdapter(
            adapterContext(
              'documentStore',
              { postgresUrl: fresh.url, prefix: `race-${i}` },
              { DATABASE_URL: fresh.url },
            ),
          )) as JsonbStore,
        )
      }

      const outcomes = await Promise.allSettled(stores.map((s) => s.initialize()))

      const failed = outcomes.filter((o) => o.status === 'rejected')
      expect(failed.map((o) => String((o as PromiseRejectedResult).reason))).toEqual([])
      const key = await queryOnce<{ column_name: string }>(
        fresh.url,
        `SELECT a.attname AS column_name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'nymbal_documents'::regclass AND i.indisprimary
          ORDER BY array_position(i.indkey, a.attnum)`,
      )
      expect(key.map((r) => r.column_name)).toEqual(['prefix', 'collection', 'key'])
      // One table, four prefixes: each replica reads back its own document under the shared key, and no other's.
      for (const [i, s] of stores.entries()) await s.put('p2-02-race', 'k', { owner: i })
      const owners = await Promise.all(
        stores.map(async (s) => (await s.get<{ owner: number }>('p2-02-race', 'k'))?.owner),
      )
      expect(owners).toEqual(stores.map((_, i) => i))
    } finally {
      for (const s of stores) await s.close()
      await fresh.drop()
    }
  })
})
