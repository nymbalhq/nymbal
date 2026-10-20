import { afterAll, describe, expect, it } from 'vitest'
import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import type { DocumentStoreAdapter } from '@nymbalhq/types'
import { documentStoreAcceptance } from '../../../tests/contracts/suites/document-store'
import { adapterContext } from '../../../tests/contracts/suites/adapter-context'
import { deleteUnder, keysUnder, redisServerUrl, uniquePrefix } from '../../../tests/support/redis'
import { createAdapter } from './index.js'

// P2-02 AC-2 on @nymbalhq/doc-store-redis (spec P2-02-primitives-are-protocols): the extended runDocumentStoreContract
// and the reference-model property (tests/contracts/suites/document-store.ts), against the composed Redis. Each store
// gets a prefix of its own under this run's, so stores never share documents and one delete cleans the run up. The
// store is built as the kernel builds it: createAdapter with the slot's connection block (decision 2). Kills, beyond
// the suites': a key written outside the prefix, which the E2E teardown (decision 7) would leave behind.

const url = redisServerUrl()
const run = uniquePrefix('doc-redis')
let count = 0

async function storeOn(prefix: string, on = url): Promise<DocumentStoreAdapter> {
  return (await createAdapter(
    adapterContext('documentStore', { url: on, prefix }),
  )) as DocumentStoreAdapter
}

const make = () => storeOn(`${run}-${(count += 1)}`)
const opts = {
  isolation: async (): Promise<[DocumentStoreAdapter, DocumentStoreAdapter]> => [
    await storeOn(`${run}-iso-a-${(count += 1)}`),
    await storeOn(`${run}-iso-b-${count}`),
  ],
}

afterAll(async () => {
  await deleteUnder(url, run)
  await deleteUnder(onDb15(), run)
})

runDocumentStoreContract('redis', make, opts)
documentStoreAcceptance('redis', make, opts)

/** The same server, logical database 15, which only the P2-02 store suites' prefixes write to. */
function onDb15(): string {
  const u = new URL(url)
  u.pathname = '/15'
  return u.toString()
}

describe('P2-02 AC-2: the Redis document store keeps everything under its prefix', () => {
  it('AC-2: after puts with and without a TTL, a batchPut and a delete, every key in the database is under a P2-02 test prefix (the stores suites share it, in parallel), and some are under the store’s', async () => {
    const prefix = `${run}-ns`
    const store = await storeOn(prefix, onDb15())
    try {
      await store.put('p2-02-ns', 'a', { id: 'a', part: 'p', v: 1 })
      await store.put('p2-02-ns', 'b', { id: 'b', part: 'q', v: 'b' }, { ttl: 60 })
      await store.batchPut('p2-02-ns-other', new Map([['c', { id: 'c', part: 'p' }]]))
      await store.delete('p2-02-ns', 'a')
      await store.query('p2-02-ns', { partitionKey: { field: 'part', value: '*' } })

      const ours = await keysUnder(onDb15(), prefix)
      const everything = await keysUnder(onDb15(), '')
      expect(ours.length).toBeGreaterThan(0)
      expect(everything.filter((key) => !key.startsWith('p2-02-'))).toEqual([])
    } finally {
      await store.close()
    }
  })
})
