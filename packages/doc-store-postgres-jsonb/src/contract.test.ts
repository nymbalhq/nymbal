import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import type { DocumentStoreAdapter } from '@nymbalhq/types'
import {
  createDatabase,
  postgresServerUrl,
  queryOnce,
  type TestDatabase,
} from '../../platform/tests/support/postgres'
import { documentStoreAcceptance } from '../../../tests/contracts/suites/document-store'
import { adapterContext } from '../../../tests/contracts/suites/adapter-context'
import { createAdapter } from './index.js'

// P2-02 AC-2 on @nymbalhq/doc-store-postgres-jsonb (spec P2-02-primitives-are-protocols): the extended
// runDocumentStoreContract and the reference-model property (tests/contracts/suites/document-store.ts), on a fresh
// database on the composed Postgres; every store gets a prefix of its own. The store is built as the kernel builds it,
// createAdapter with the connection (decision 1: the postgresUrl option, then DATABASE_URL) and initialize() (decision
// 5). Kills, beyond the suites': replicas that start together failing a boot on the table's DDL (M3).

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

const make = () => storeOn(db.url, `p2-02-${(count += 1)}`)
const opts = {
  isolation: async (): Promise<[DocumentStoreAdapter, DocumentStoreAdapter]> => [
    await storeOn(db.url, `p2-02-iso-a-${(count += 1)}`),
    await storeOn(db.url, `p2-02-iso-b-${count}`),
  ],
}

runDocumentStoreContract('postgres-jsonb', make, opts)
documentStoreAcceptance('postgres-jsonb', make, opts)

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
