import { afterAll, describe, expect, it } from 'vitest'
import {
  adapterContext,
  runDocumentStoreContract,
  type DocumentStoreContractOptions,
} from '@nymbalhq/contract-tests'
import type { DocumentStoreAdapter, Logger } from '@nymbalhq/types'
import { deleteUnder, keysUnder, redisServerUrl, uniquePrefix } from '../../../tests/support/redis'
import {
  closeBounded,
  settleWithin,
  tcpProxy,
  type TcpProxy,
} from '../../../tests/support/tcp-proxy'
import { createAdapter } from './index.js'

// P2-02 AC-2 on @nymbalhq/doc-store-redis (spec P2-02-primitives-are-protocols), against the composed Redis, and
// P2-13 AC-2 and AC-5 (spec P2-13-contract-tests-public): runDocumentStoreContract from the published package runs the
// old cases and the reference-model property, and, given `unreachable`, the downtime cases. Each store gets a prefix of
// its own under this run's, so stores never share documents and one delete cleans the run up. The store is built as
// the kernel builds it: createAdapter with the slot's connection block (P2-02 decision 2). `unreachable` is a store
// built through a TCP proxy while Redis is up, whose proxy then closes (P2-13 decision 3): the client connected at
// construction is left on a port that refuses. Kills, beyond the suite's: a key written outside the prefix (the E2E
// teardown would leave it behind), a client that retries a dead host forever (decision 4, B1: an unbounded `hget` was
// still pending at 15 s), and a bound that stops the client reconnecting when the host returns.

const url = redisServerUrl()
const run = uniquePrefix('doc-redis')
let count = 0
const proxies: TcpProxy[] = []

/** Within this a command on a dead host has rejected (decision 4); past HUNG_AFTER_MS it has hung. */
const DOWN_WITHIN_MS = 6000
const HUNG_AFTER_MS = 12_000

async function storeOn(prefix: string, on = url): Promise<DocumentStoreAdapter> {
  return (await createAdapter(
    adapterContext('documentStore', { url: on, prefix }),
  )) as DocumentStoreAdapter
}

/** A store connected through a proxy that is then closed: built while Redis is up, then left unreachable. */
async function unreachable(): Promise<DocumentStoreAdapter> {
  const proxy = await tcpProxy(new URL(url))
  proxies.push(proxy)
  const store = await storeOn(`${run}-down-${(count += 1)}`, proxy.url(url))
  await store.get('p2-13-probe', 'connected')
  await proxy.close()
  return store
}

const make = () => storeOn(`${run}-${(count += 1)}`)
const opts: DocumentStoreContractOptions = {
  isolation: async (): Promise<[DocumentStoreAdapter, DocumentStoreAdapter]> => [
    await storeOn(`${run}-iso-a-${(count += 1)}`),
    await storeOn(`${run}-iso-b-${count}`),
  ],
  unreachable,
}

afterAll(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close()
  await deleteUnder(url, run)
  await deleteUnder(onDb15(), run)
})

runDocumentStoreContract('redis', make, opts)

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

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

describe('P2-13 AC-5 (decision 4, B1): the Redis document store’s client is bounded and still reconnects', () => {
  it('AC-5: built through a proxy that then closes, a get rejects within 6 s instead of hanging; once the port answers again, the same store reads its document back', async () => {
    const proxy = await tcpProxy(new URL(url))
    proxies.push(proxy)
    // Built from the adapter's own entry, so this case depends on the client and nothing in the suites package.
    const store = (await createAdapter({
      slot: 'documentStore',
      config: { url: proxy.url(url), prefix: `${run}-bounded` },
      logger: silent,
      env: {},
    })) as DocumentStoreAdapter
    try {
      await store.put('p2-13-bounded', 'k', { v: 1 })
      await proxy.close()

      const down = await settleWithin(store.get('p2-13-bounded', 'k'), HUNG_AFTER_MS)
      expect(down.state).toBe('rejected')
      expect(down.ms).toBeLessThan(DOWN_WITHIN_MS)

      // Reconnecting is the client's retry loop, so the read is retried until a deadline rather than once.
      await proxy.reopen()
      const deadline = Date.now() + 20_000
      let back = await settleWithin(store.get('p2-13-bounded', 'k'), DOWN_WITHIN_MS)
      while (back.state !== 'resolved' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
        back = await settleWithin(store.get('p2-13-bounded', 'k'), DOWN_WITHIN_MS)
      }
      expect([back.state, back.value]).toEqual(['resolved', { v: 1 }])
    } finally {
      await proxy.close()
      await closeBounded(() => store.close())
    }
  }, 60_000)
})
