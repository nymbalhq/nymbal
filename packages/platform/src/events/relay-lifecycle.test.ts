import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CART_UPDATED, type EventBusAdapter, type NymbalEvent } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import {
  createCommandStore,
  rawClients,
  sqliteTurn,
  type CommandStore,
} from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { buildRepositories } from '../repositories/index.js'
import type { EventLogRepository } from '../repositories/event-log.js'
import { createLogger } from '../logger.js'
import { TEST_BUILDER_CONTEXT } from '../tests/publisher.js'
import { createEventBuilder } from './builder.js'
import { createRelay, deliveringBus, type Relay } from './relay.js'

// The relay's life around its passes: a relay with no outage probe counts every failure; start() delivers on its
// interval with no drain asked for, and stop() ends that and every later drain; stop() waits for the pass in flight,
// except when a handler inside that pass calls it; a handler that drains or stops from inside a delivery does not
// wait on the pass delivering to it, and a stop there leaves the rest of the page undelivered; the bus subscribers
// see hands every call through to the bus underneath.

const START = Date.parse('2026-03-01T09:00:00.000Z')
const silent = createLogger({ pretty: false, level: 'silent' })
const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

let store: CommandStore
let eventLog: EventLogRepository

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error a minimal config: only the command store kind is read
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'relay', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  eventLog = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 })).eventLog
})

afterAll(async () => {
  await store?.close()
})

function sqlite() {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error('expected the SQLite command store')
  return clients.raw
}

interface Row {
  attempts: number
  retryAt: number | null
  delivered: boolean
}

async function rowOf(id: string): Promise<Row> {
  const row = await sqliteTurn(
    sqlite(),
    () =>
      sqlite()
        .prepare('SELECT attempts, retry_at, delivered_at FROM events WHERE id = ?')
        .get(id) as { attempts: number; retry_at: string | null; delivered_at: string | null },
  )
  return {
    attempts: Number(row.attempts),
    retryAt: row.retry_at === null ? null : Date.parse(row.retry_at),
    delivered: row.delivered_at !== null,
  }
}

/** Takes every open row out of the log, so a pass sees only what the test appends next. */
async function settleEarlierRows(): Promise<void> {
  await sqliteTurn(sqlite(), () =>
    sqlite()
      .prepare('UPDATE events SET delivered_at = ? WHERE delivered_at IS NULL AND dead_at IS NULL')
      .run(new Date(START).toISOString()),
  )
}

const cartEvent = (i: number) =>
  makeEvent(EVT_CART_UPDATED, { cartId: `cart-${i}`, itemCount: i, totalMinor: 0 })

async function append(n: number): Promise<string[]> {
  const events = Array.from({ length: n }, (_, i) => cartEvent(i))
  await store.transaction((tx) => eventLog.append(tx, events))
  return events.map((e) => e.id)
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(check: () => Promise<boolean>, label: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`)
    await delay(5)
  }
}

/** A bus whose publish runs `onPublish` and records each id handed to it. */
function recordingBus(onPublish: (event: NymbalEvent<unknown>) => Promise<void> = async () => {}) {
  const published: string[] = []
  const bus = {
    async publish(event: NymbalEvent<unknown>) {
      published.push(event.id)
      await onPublish(event)
    },
  } as unknown as EventBusAdapter
  return { bus, published }
}

const relayOver = (
  eventBus: EventBusAdapter,
  more: Partial<Parameters<typeof createRelay>[0]> = {},
) => createRelay({ store, eventLog, eventBus, logger: silent, ...more })

describe('the relay with no outage probe', () => {
  it('counts a failed delivery as a failure: attempts goes to 1 and retry_at is the failure time + retryDelayMs', async () => {
    await settleEarlierRows()
    const retryDelayMs = 60_000
    const { bus } = recordingBus(async () => {
      throw new Error('the bus refused the event')
    })
    const relay = relayOver(bus, { retryDelayMs, now: () => new Date(START) })
    const [id] = await append(1)

    await relay.drain()

    expect(await rowOf(id!)).toEqual({
      attempts: 1,
      retryAt: START + retryDelayMs,
      delivered: false,
    })
  })
})

describe('start and stop', () => {
  it('start() delivers a logged event on its interval with no drain asked for; after stop(), neither the interval nor a drain delivers', async () => {
    await settleEarlierRows()
    const { bus, published } = recordingBus()
    const relay = relayOver(bus, { intervalMs: 10 })
    const [first] = await append(1)

    relay.start()
    await until(async () => (await rowOf(first!)).delivered, 'the interval to deliver')
    await relay.stop()
    const handed = published.length
    const [second] = await append(1)
    await delay(60)
    await relay.drain()

    expect(published.length, 'events handed to the bus after stop()').toBe(handed)
    expect(await rowOf(second!)).toEqual({ attempts: 0, retryAt: null, delivered: false })
  })

  it('stop() resolves only once the pass in flight has delivered its event', async () => {
    await settleEarlierRows()
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const marks: string[] = []
    const { bus, published } = recordingBus(() => held)
    const relay = relayOver(bus)
    const [id] = await append(1)

    const draining = relay.drain()
    await until(async () => published.length === 1, 'the bus to hold the event')
    const stopping = relay.stop().then(() => void marks.push('stopped'))
    await delay(20)
    marks.push('released')
    release()
    await Promise.all([draining, stopping])

    expect(marks).toEqual(['released', 'stopped'])
    expect((await rowOf(id!)).delivered).toBe(true)
  })
})

describe('a handler inside a delivery', () => {
  it('that calls stop() is not held by the pass delivering to it, and the rest of that page is not handed to the bus', async () => {
    await settleEarlierRows()
    let relay!: Relay
    const { bus, published } = recordingBus(async () => {
      if (published.length === 1) await relay.stop()
    })
    relay = relayOver(bus)
    const ids = await append(3)

    await relay.drain()

    expect(published).toEqual(ids.slice(0, 1))
    const rows = await Promise.all(ids.map(rowOf))
    expect(rows.map((r) => r.delivered)).toEqual([true, false, false])
  })

  it('that drains is not held by the pass delivering to it, and its own event is delivered by that pass', async () => {
    await settleEarlierRows()
    let relay!: Relay
    const drained: string[] = []
    const { bus } = recordingBus(async (event) => {
      await relay.drain()
      drained.push(event.id)
    })
    relay = relayOver(bus)
    const [id] = await append(1)

    await relay.drain()

    expect(drained).toEqual([id])
    expect((await rowOf(id!)).delivered).toBe(true)
  })
})

describe('the bus subscribers see', () => {
  it('hands capabilities, publish, publishBatch, replay, unsubscribe and close through to the bus underneath', async () => {
    const underneath = new InProcessEventBus({ logger: silent })
    const relay = relayOver(underneath)
    const bus = deliveringBus(underneath, relay)
    const live: string[] = []
    const derived: string[] = []
    const gone: string[] = []
    await bus.subscribe(EVT_CART_UPDATED, async (e) => void live.push(e.id))
    await bus.subscribe(EVT_CART_UPDATED, async (e) => void derived.push(e.id), {
      name: 'relay-lifecycle-projection',
      derived: true,
    })
    const leaving = await bus.subscribe(EVT_CART_UPDATED, async (e) => void gone.push(e.id))
    const [a, b, c, d, e] = [0, 1, 2, 3, 4].map(cartEvent)

    expect(bus.capabilities()).toEqual(underneath.capabilities())
    await bus.publish(a!)
    await bus.unsubscribe(leaving)
    await bus.publishBatch([b!, c!])
    await bus.replay([d!])
    await bus.close()
    await underneath.publish(e!)

    expect(live).toEqual([a!.id, b!.id, c!.id])
    expect(derived).toEqual([a!.id, b!.id, c!.id, d!.id])
    expect(gone).toEqual([a!.id])
  })
})
