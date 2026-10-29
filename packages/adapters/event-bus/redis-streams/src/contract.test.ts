import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  adapterContext,
  runEventBusContract,
  type EventBusContractOptions,
} from '@nymbalhq/contract-tests'
import type { EventBusAdapter, Logger } from '@nymbalhq/types'
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
import { createAdapter } from './index.js'

// runEventBusContract from the published package on @nymbalhq/event-bus-redis-streams, against the composed Redis,
// including the cases only a shared bus has (`second` is another instance on the streams of the bus `make` built
// last). The knobs are small so the claim and timeout windows are seen in a test: claimIdleMs 400, ackTimeoutMs 4000
// (ackTimeoutMs must exceed claimIdleMs plus the slowest handler, 200 ms here). `unreachable` is a bus built through a
// TCP proxy while Redis is up, whose proxy then closes. Beyond the suite: every key stays under the prefix, streams are
// trimmed, and the writer is bounded on a dead host and reconnects when it returns.

const url = redisServerUrl()
const run = uniquePrefix('streams')
const TIMING = { claimIdleMs: 400, ackTimeoutMs: 4000 }
let count = 0
let prefix = ''

async function busOn(p: string, extra: Record<string, unknown> = {}, on = url) {
  return (await createAdapter(
    adapterContext('eventBus', { url: on, prefix: p, ...TIMING, ...extra }),
  )) as EventBusAdapter
}

const proxies: TcpProxy[] = []

/** Within this a command on a dead host has rejected; past HUNG_AFTER_MS it has hung. */
const DOWN_WITHIN_MS = 6000
const HUNG_AFTER_MS = 12_000

const make = () => {
  prefix = `${run}-${(count += 1)}`
  return busOn(prefix)
}
const second = () => busOn(prefix)

/** A bus connected through a proxy that is then closed: built while Redis is up, then left unreachable. */
async function unreachable(): Promise<EventBusAdapter> {
  const proxy = await tcpProxy(new URL(url))
  proxies.push(proxy)
  const bus = await busOn(`${run}-down-${(count += 1)}`, {}, proxy.url(url))
  await bus.publish(event('p2.down.probe'))
  await proxy.close()
  return bus
}

const opts: EventBusContractOptions = { second, timing: TIMING, unreachable }

afterAll(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close()
  await deleteUnder(url, run)
  await deleteUnder(onDb15(), run)
})

runEventBusContract('redis-streams', make, opts)

// What the bus logs for an unnamed handler's throw: the contract cannot read an adapter's logger, so this runner does.
describe('Redis Streams bus: an unnamed handler failure', () => {
  it('AC-1: a throwing unnamed handler leaves each of two publishes resolved, the named handler beside it handled each event once, and for each exactly one log line names the unnamed subscription and that event', async () => {
    const logged: unknown[][] = []
    const keeping: Logger = {
      trace: (...args) => void logged.push(args),
      debug: (...args) => void logged.push(args),
      info: (...args) => void logged.push(args),
      warn: (...args) => void logged.push(args),
      error: (...args) => void logged.push(args),
      child: () => keeping,
    }
    const bus = (await createAdapter({
      ...adapterContext('eventBus', { url, prefix: `${run}-unnamed`, ...TIMING }),
      logger: keeping,
    })) as EventBusAdapter
    try {
      const type = 'p2.unnamed.failure'
      const named: string[] = []
      await bus.subscribe(type, async (e: { id: string }) => void named.push(e.id), {
        name: 'primitives-unnamed-named',
      })
      const tab = await bus.subscribe(type, async () => {
        throw new Error('contract admin tab refused')
      })
      const events = [event(type), event(type)]

      for (const e of events) await expect(bus.publish(e)).resolves.toBeUndefined()

      expect(named).toEqual(events.map((e) => e.id))
      const lines = logged.map((args) => JSON.stringify(args))
      for (const e of events) {
        const naming = lines.filter((text) => text.includes(tab.id) && text.includes(e.id))
        expect(naming, `log lines naming the unnamed subscription and ${e.id}`).toHaveLength(1)
      }
    } finally {
      await bus.close()
    }
  })
})

function onDb15(): string {
  const u = new URL(url)
  u.pathname = '/15'
  return u.toString()
}

function event(type: string) {
  return {
    id: `evt-${randomUUID()}`,
    type,
    timestamp: new Date().toISOString(),
    source: 'primitives-streams',
    correlationId: 'corr-primitives',
    payload: {},
    metadata: { storeId: 'primitives', environment: 'development' as const, version: '0.0.0' },
  }
}

describe('AC-3: the Redis Streams bus keeps its streams under the prefix, trimmed', () => {
  it('AC-3: with streamMaxLen 20, after 300 publishes and a named and an unnamed subscription, every key in the database is under a store-suite test prefix (the stores suites share it, in parallel), and the streams hold fewer entries than were published', async () => {
    const p = `${run}-trim`
    const bus = await busOn(p, { streamMaxLen: 20 }, onDb15())
    try {
      const handled: string[] = []
      await bus.subscribe('p2.trim.*', async (e: { id: string }) => void handled.push(e.id), {
        name: 'primitives-trim',
      })
      const sub = await bus.subscribe('p2.trim.*', async () => undefined)
      const published = Array.from({ length: 300 }, () => event('p2.trim.x'))
      for (const e of published) await bus.publish(e)
      await bus.unsubscribe(sub)

      const ours = await keysUnder(onDb15(), p)
      const everything = await keysUnder(onDb15(), '')
      expect(everything.filter((key) => !key.startsWith('primitives-'))).toEqual([])
      const types = await redis(
        onDb15(),
        ours.map((key) => ['TYPE', key]),
      )
      const streams = ours.filter((_, i) => types[i] === 'stream')
      expect(streams.length).toBeGreaterThan(0)
      const lengths = await redis(
        onDb15(),
        streams.map((key) => ['XLEN', key]),
      )
      const entries = (lengths as number[]).reduce((a, b) => a + b, 0)
      expect(entries).toBeLessThan(published.length)
      expect(handled.length).toBe(published.length)
    } finally {
      await bus.close()
    }
  }, 60_000)
})

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

describe('AC-5: the Redis Streams writer is bounded and still reconnects', () => {
  it('AC-5: built through a proxy that then closes, a publish rejects within 6 s instead of hanging; once the port answers again, the same bus publishes to a named subscription that handles it', async () => {
    const proxy = await tcpProxy(new URL(url))
    proxies.push(proxy)
    // Built from the adapter's own entry, so this case depends on the client and nothing in the suites package.
    const bus = (await createAdapter({
      slot: 'eventBus',
      config: { url: proxy.url(url), prefix: `${run}-bounded`, ...TIMING },
      logger: silent,
      env: {},
    })) as EventBusAdapter
    try {
      const handled: string[] = []
      await bus.subscribe('p2.bounded.*', async (e: { id: string }) => void handled.push(e.id), {
        name: 'contracts-bounded',
      })
      await bus.publish(event('p2.bounded.before'))
      await proxy.close()

      const down = await settleWithin(bus.publish(event('p2.bounded.during')), HUNG_AFTER_MS)
      expect(down.state).toBe('rejected')
      expect(down.ms).toBeLessThan(DOWN_WITHIN_MS)

      // Reconnecting is the client's retry loop, so the publish is retried until a deadline rather than once.
      await proxy.reopen()
      const after = event('p2.bounded.after')
      const deadline = Date.now() + 20_000
      let back = await settleWithin(bus.publish(after), DOWN_WITHIN_MS)
      while (back.state !== 'resolved' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
        back = await settleWithin(bus.publish(after), DOWN_WITHIN_MS)
      }
      expect(back.state).toBe('resolved')
      expect(handled).toContain(after.id)
    } finally {
      await proxy.close()
      await closeBounded(() => bus.close())
    }
  }, 60_000)
})
