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
} from '../../../../platform/tests/support/postgres'
import { closedPort } from '../../../../../tests/support/tcp-proxy'
import { createAdapter } from './index.js'

// runDocumentStoreContract from the published package on @nymbalhq/document-store-postgres-jsonb, on a fresh database on
// the composed Postgres; every store gets a prefix of its own. The store is built as the kernel builds it
// (createAdapter with the connection, then initialize()). `unreachable` is a store on a closed port: pg connects per
// query, so nothing needs to be up first.

type JsonbStore = DocumentStoreAdapter & { initialize(): Promise<void> }

let db: TestDatabase
let count = 0

beforeAll(async () => {
  db = await createDatabase(postgresServerUrl(), 'primitives_jsonb')
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
      { postgresUrl: url, prefix: 'contracts-down' },
      { DATABASE_URL: url },
    ),
  )) as DocumentStoreAdapter
}

const make = () => storeOn(db.url, `primitives-${(count += 1)}`)
const opts: DocumentStoreContractOptions = {
  isolation: async (): Promise<[DocumentStoreAdapter, DocumentStoreAdapter]> => [
    await storeOn(db.url, `primitives-iso-a-${(count += 1)}`),
    await storeOn(db.url, `primitives-iso-b-${count}`),
  ],
  unreachable,
}

runDocumentStoreContract('postgres-jsonb', make, opts)

describe('AC-2: Postgres JSONB owns its table', () => {
  it('AC-2: four replicas initialize() at once on a database without the table, every one succeeds, and nymbal_documents is keyed (prefix, collection, key)', async () => {
    const fresh = await createDatabase(postgresServerUrl(), 'primitives_jsonb_race')
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
      for (const [i, s] of stores.entries()) await s.put('primitives-race', 'k', { owner: i })
      const owners = await Promise.all(
        stores.map(async (s) => (await s.get<{ owner: number }>('primitives-race', 'k'))?.owner),
      )
      expect(owners).toEqual(stores.map((_, i) => i))
    } finally {
      for (const s of stores) await s.close()
      await fresh.drop()
    }
  })
})
