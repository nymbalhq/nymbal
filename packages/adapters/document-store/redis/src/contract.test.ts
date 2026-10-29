import { afterAll, describe, expect, it } from 'vitest'
import {
  adapterContext,
  runDocumentStoreContract,
  type DocumentStoreContractOptions,
} from '@nymbalhq/contract-tests'
import type { DocumentStoreAdapter, Logger } from '@nymbalhq/types'
import {
  deleteUnder,
  keysUnder,
  redis,
  redisServerUrl,
  uniquePrefix,
} from '../../../../../tests/support/redis'
import {
  closeBounded,
  settleWithin,
  tcpProxy,
  type TcpProxy,
} from '../../../../../tests/support/tcp-proxy'
import { createAdapter, createRedisDocumentStore } from './index.js'

// runDocumentStoreContract from the published package on @nymbalhq/document-store-redis, against the composed Redis. Each
// store gets a prefix of its own under this run's, so stores never share documents and one delete cleans the run up.
// `unreachable` is a store built through a TCP proxy while Redis is up, whose proxy then closes: the client connected
// at construction is left on a port that refuses. Beyond the suite: every key stays under the prefix, the client is
// bounded on a dead host and reconnects when it returns, and replaceCollection's staging keys never outlive a rebuild.

const url = redisServerUrl()
const run = uniquePrefix('doc-redis')
let count = 0
const proxies: TcpProxy[] = []

/** Within this a command on a dead host has rejected; past HUNG_AFTER_MS it has hung. */
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
  await store.get('contracts-probe', 'connected')
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

/** The same server, logical database 15, which only the store suites' prefixes write to. */
function onDb15(): string {
  const u = new URL(url)
  u.pathname = '/15'
  return u.toString()
}

describe('AC-2: the Redis document store keeps everything under its prefix', () => {
  it('AC-2: after puts with and without a TTL, a batchPut and a delete, every key in the database is under a store-suite test prefix (the stores suites share it, in parallel), and some are under the store’s', async () => {
    const prefix = `${run}-ns`
    const store = await storeOn(prefix, onDb15())
    try {
      await store.put('primitives-ns', 'a', { id: 'a', part: 'p', v: 1 })
      await store.put('primitives-ns', 'b', { id: 'b', part: 'q', v: 'b' }, { ttl: 60 })
      await store.batchPut('primitives-ns-other', new Map([['c', { id: 'c', part: 'p' }]]))
      await store.delete('primitives-ns', 'a')
      await store.query('primitives-ns', { partitionKey: { field: 'part', value: '*' } })

      const ours = await keysUnder(onDb15(), prefix)
      const everything = await keysUnder(onDb15(), '')
      expect(ours.length).toBeGreaterThan(0)
      expect(everything.filter((key) => !key.startsWith('primitives-'))).toEqual([])
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

describe('AC-5: the Redis document store’s client is bounded and still reconnects', () => {
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
      await store.put('contracts-bounded', 'k', { v: 1 })
      await proxy.close()

      const down = await settleWithin(store.get('contracts-bounded', 'k'), HUNG_AFTER_MS)
      expect(down.state).toBe('rejected')
      expect(down.ms).toBeLessThan(DOWN_WITHIN_MS)

      // Reconnecting is the client's retry loop, so the read is retried until a deadline rather than once.
      await proxy.reopen()
      const deadline = Date.now() + 20_000
      let back = await settleWithin(store.get('contracts-bounded', 'k'), DOWN_WITHIN_MS)
      while (back.state !== 'resolved' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
        back = await settleWithin(store.get('contracts-bounded', 'k'), DOWN_WITHIN_MS)
      }
      expect([back.state, back.value]).toEqual(['resolved', { v: 1 }])
    } finally {
      await proxy.close()
      await closeBounded(() => store.close())
    }
  }, 60_000)
})

/** Every key under `prefix` with its contents, as Redis holds them: what a replace may and may not leave behind. */
async function keyspace(on: string, prefix: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of (await keysUnder(on, prefix)).sort()) {
    const [type] = (await redis(on, [['TYPE', key]])) as [string]
    const [value] =
      type === 'hash'
        ? await redis(on, [['HGETALL', key]])
        : type === 'zset'
          ? await redis(on, [['ZRANGE', key, '0', '-1', 'WITHSCORES']])
          : type === 'set'
            ? await redis(on, [['SMEMBERS', key]])
            : await redis(on, [['GET', key]])
    out[key] = { type, value: type === 'set' ? (value as string[]).sort() : value }
  }
  return out
}

describe('AC-1: the Redis replace swaps the docs hash and its expiry index, and cleans its staging keys', () => {
  it('AC-1: a replace whose source throws after two entries leaves every key under the prefix as it was (no staging key, the old set intact); a replace that succeeds leaves the new set exactly, an expiry index holding only keys of that set, and no key outside the store’s own', async () => {
    let now = Date.UTC(2026, 9, 21)
    const prefix = `${run}-replace`
    const store = await createRedisDocumentStore({
      url,
      prefix,
      sweepIntervalMs: 0,
      now: () => now,
    })
    try {
      await store.put('replay', 'old-ttl', { id: 'old-ttl', part: 'p' }, { ttl: 60 })
      await store.put('replay', 'kept', { id: 'kept', part: 'p', v: 'old' })
      await store.put('replay', 'gone', { id: 'gone', part: 'p' })
      await store.put('replay-other', 'x', { id: 'x', part: 'p' }, { ttl: 60 })
      const before = await keyspace(url, prefix)

      async function* failing(): AsyncGenerator<[string, unknown]> {
        yield ['kept', { id: 'kept', part: 'p', v: 'new' }]
        yield ['new', { id: 'new', part: 'p' }]
        throw new Error('replay: the source failed')
      }
      const failed = await store.replaceCollection('replay', failing()).then(
        () => null,
        (error: unknown) => error,
      )
      expect(String(failed)).toContain('replay: the source failed')
      expect(await keyspace(url, prefix)).toEqual(before)

      async function* good(): AsyncGenerator<[string, unknown]> {
        yield ['kept', { id: 'kept', part: 'p', v: 'new' }]
        yield ['new', { id: 'new', part: 'p' }]
      }
      await store.replaceCollection('replay', good())
      const all = await store.query('replay', { partitionKey: { field: 'part', value: '*' } })
      expect(all.items).toEqual([
        { id: 'kept', part: 'p', v: 'new' },
        { id: 'new', part: 'p' },
      ])

      const docs = `${prefix}:doc:replay`
      const expiry = `${prefix}:exp:replay`
      const [fields] = (await redis(url, [['HKEYS', docs]])) as [string[]]
      const [expiring] = (await redis(url, [['ZRANGE', expiry, '0', '-1']])) as [string[]]
      for (const key of expiring) expect(fields, `expiry index entry ${key}`).toContain(key)
      const own = new Set([
        docs,
        expiry,
        `${prefix}:doc:replay-other`,
        `${prefix}:exp:replay-other`,
        `${prefix}:expiring`,
      ])
      expect((await keysUnder(url, prefix)).filter((key) => !own.has(key))).toEqual([])
      // The other collection's TTL document is untouched by the replace, and still expires.
      expect(await store.get('replay-other', 'x')).toEqual({ id: 'x', part: 'p' })
      now += 61_000
      expect(await store.get('replay-other', 'x')).toBeNull()
    } finally {
      await store.close()
    }
  })
})
