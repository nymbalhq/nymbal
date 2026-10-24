import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { NymbalEvent, Subscription } from '@nymbalhq/types'
import { deleteUnder, redisServerUrl, uniquePrefix } from '../../../tests/support/redis'
import { createRedisStreamsEventBus, RedisStreamsEventBus } from './redis-streams-event-bus.js'

// The Redis Streams bus at two interleavings the shared contract suites cannot schedule: a group's last local
// subscription leaving in the middle of a batch, and an entry the tail reads while an unnamed subscription is still
// reading its starting point. Each is set up so the order is fixed, not raced.

const url = redisServerUrl()
const run = uniquePrefix('streams-order')
const TIMING = { claimIdleMs: 400, ackTimeoutMs: 4000 }
let count = 0

afterAll(async () => {
  await deleteUnder(url, run)
})

function event(type: string): NymbalEvent {
  return {
    id: `evt-${randomUUID()}`,
    type,
    timestamp: new Date().toISOString(),
    source: 'primitives-streams',
    correlationId: 'corr-primitives',
    payload: {},
    metadata: { storeId: 'primitives', environment: 'development', version: '0.0.0' },
  }
}

describe('the Redis Streams bus keeps a batch when its group leaves this instance', () => {
  it('entries read in one batch after the last local subscription of a group unsubscribes are handled by the group’s consumer on another instance', async () => {
    const prefix = `${run}-${(count += 1)}`
    const group = 'primitives-leaves'
    const a = await createRedisStreamsEventBus({ url, prefix, ...TIMING })
    const publisher = await createRedisStreamsEventBus({ url, prefix, ...TIMING })
    let b: RedisStreamsEventBus | undefined
    try {
      // The group exists before anything is published, so one read on A takes the whole batch.
      await (await a.subscribe('p2.leave.*', async () => undefined, { name: group })).unsubscribe()
      const published = Array.from({ length: 10 }, () => event('p2.leave.x'))
      await publisher.publishBatch(published)

      const onA: string[] = []
      const leaving: Promise<Subscription> = a.subscribe(
        'p2.leave.*',
        async (e: NymbalEvent) => {
          onA.push(e.id)
          void leaving.then((s) => s.unsubscribe())
        },
        { name: group },
      )
      await leaving
      await vi.waitFor(() => expect(onA.length).toBeGreaterThan(0))

      const onB: string[] = []
      b = await createRedisStreamsEventBus({ url, prefix, ...TIMING })
      await b.subscribe('p2.leave.*', async (e: NymbalEvent) => void onB.push(e.id), {
        name: group,
      })
      await vi.waitFor(() => expect(onA.length + onB.length).toBe(published.length), {
        timeout: 5_000,
        interval: 50,
      })
      expect(onA).toEqual([published[0]!.id])
      expect([...onA, ...onB].sort()).toEqual(published.map((e) => e.id).sort())
    } finally {
      await b?.close()
      await publisher.close()
      await a.close()
    }
  }, 30_000)
})

describe('the Redis Streams bus feeds an unnamed subscription what arrives while it subscribes', () => {
  it('an entry the tail reads between the subscription reading its starting point and that reply arriving is delivered to it', async () => {
    const prefix = `${run}-${(count += 1)}`
    const stream = `${prefix}:events`
    const cmd = new Redis(url)
    const reader = new Redis(url, { maxRetriesPerRequest: null })
    const other = new Redis(url)
    const bus = new RedisStreamsEventBus(cmd, reader, { url, prefix, ...TIMING })
    try {
      const onFirst: string[] = []
      const onSecond: string[] = []
      // The first subscription starts the tail, so the second's only read of the stream is its starting point.
      await bus.subscribe('p2.join.*', async (e: NymbalEvent) => void onFirst.push(e.id))

      const between = event('p2.join.x')
      const realXrevrange = cmd.xrevrange.bind(cmd) as (...args: unknown[]) => Promise<unknown>
      let armed = true
      cmd.xrevrange = (async (...args: unknown[]) => {
        const reply = await realXrevrange(...args)
        if (!armed) return reply
        armed = false
        // The reply is in hand; the entry lands and the tail feeds it before the reply is processed. The tail feeds
        // every unnamed subscription in one synchronous pass, so the first one holding it means the pass is done.
        await other.xadd(stream, '*', 'type', between.type, 'event', JSON.stringify(between))
        await vi.waitFor(() => expect(onFirst).toContain(between.id), { interval: 5 })
        return reply
      }) as unknown as typeof cmd.xrevrange

      await bus.subscribe('p2.join.*', async (e: NymbalEvent) => void onSecond.push(e.id))
      const after = event('p2.join.x')
      await bus.publish(after)

      expect(onFirst).toEqual([between.id, after.id])
      expect(onSecond).toEqual([between.id, after.id])
    } finally {
      await bus.close()
      await other.quit()
    }
  }, 30_000)
})
