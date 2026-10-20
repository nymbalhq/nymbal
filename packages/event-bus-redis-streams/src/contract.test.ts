import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { runEventBusContract } from '@nymbalhq/contract-tests'
import type { EventBusAdapter } from '@nymbalhq/types'
import { eventBusAcceptance } from '../../../tests/contracts/suites/event-bus'
import { adapterContext } from '../../../tests/contracts/suites/adapter-context'
import {
  deleteUnder,
  keysUnder,
  redis,
  redisServerUrl,
  uniquePrefix,
} from '../../../tests/support/redis'
import { createAdapter } from './index.js'

// P2-02 AC-3 on @nymbalhq/event-bus-redis-streams (spec P2-02-primitives-are-protocols): the extended
// runEventBusContract and the delivery contract (tests/contracts/suites/event-bus.ts) against the composed Redis,
// including the cases only a shared bus has: `second` is another instance on the streams of the bus `make` built last.
// The knobs are small so the claim and timeout windows are seen in a test: claimIdleMs 400, ackTimeoutMs 4000 (decision
// 4 orders them: ackTimeoutMs exceeds claimIdleMs plus the slowest handler, 200 ms here). Kills, beyond the suites': a
// key or stream outside the prefix (the E2E teardown would leave it), and a stream that is never trimmed.

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

const make = () => {
  prefix = `${run}-${(count += 1)}`
  return busOn(prefix)
}
const second = () => busOn(prefix)

afterAll(async () => {
  await deleteUnder(url, run)
  await deleteUnder(onDb15(), run)
})

runEventBusContract('redis-streams', make, { second })
eventBusAcceptance('redis-streams', make, { second, timing: TIMING })

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
    source: 'p2-02-streams',
    correlationId: 'corr-p2-02',
    payload: {},
    metadata: { storeId: 'p2-02', environment: 'development' as const, version: '0.0.0' },
  }
}

describe('P2-02 AC-3 (decision 4): the Redis Streams bus keeps its streams under the prefix, trimmed', () => {
  it('AC-3: with streamMaxLen 20, after 300 publishes and a named and an unnamed subscription, every key in the database is under a P2-02 test prefix (the stores suites share it, in parallel), and the streams hold fewer entries than were published', async () => {
    const p = `${run}-trim`
    const bus = await busOn(p, { streamMaxLen: 20 }, onDb15())
    try {
      const handled: string[] = []
      await bus.subscribe('p2.trim.*', async (e: { id: string }) => void handled.push(e.id), {
        name: 'p2-02-trim',
      })
      const sub = await bus.subscribe('p2.trim.*', async () => undefined)
      const published = Array.from({ length: 300 }, () => event('p2.trim.x'))
      for (const e of published) await bus.publish(e)
      await bus.unsubscribe(sub)

      const ours = await keysUnder(onDb15(), p)
      const everything = await keysUnder(onDb15(), '')
      expect(everything.filter((key) => !key.startsWith('p2-02-'))).toEqual([])
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
