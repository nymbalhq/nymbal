import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EVT_CART_UPDATED, type NymbalEvent } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import {
  createCommandStore,
  rawClients,
  sqliteTurn,
  type CommandStore,
} from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createLogger } from '../logger.js'
import { wirePublisher } from '../tests/publisher.js'
import { createEventPublisher, type EventPublisher } from './publisher.js'
import { createRelay, type Relay } from './relay.js'

// publishMany: every event it is given is logged in one write and handed to the bus in order by the relay, each with
// its own options (an explicit correlation id is kept; with none the event is its own); an empty list logs nothing.
// publishUntyped: events of a type the kernel does not declare take the one set of options given, are logged and
// returned as built, and reach the bus after a pass; an empty list opens no write and asks for no pass.

let store: CommandStore
let publisher: EventPublisher
let relay: Relay
const received: NymbalEvent<unknown>[] = []
const UNTYPED = 'acme.parcel.scanned.v1'
const untyped: NymbalEvent<unknown>[] = []

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error a minimal config: only the command store kind is read
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'publisher', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'silent' })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const eventBus = new InProcessEventBus({ logger })
  await eventBus.subscribe(EVT_CART_UPDATED, async (e) => void received.push(e))
  await eventBus.subscribe(UNTYPED, async (e) => void untyped.push(e))
  const wired = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus, logger },
  )
  publisher = wired.publisher
  relay = wired.relay
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await store?.close()
})

async function loggedIds(): Promise<string[]> {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error('expected a SQLite store')
  const rows = await sqliteTurn(
    clients.raw,
    () =>
      clients.raw
        .prepare('SELECT id FROM events WHERE delivered_at IS NOT NULL ORDER BY seq')
        .all() as {
        id: string
      }[],
  )
  return rows.map((r) => r.id)
}

describe('publishMany', () => {
  it('logs and delivers every event in order, each with its own correlation id; an empty list logs nothing', async () => {
    const before = await loggedIds()
    await publisher.publishMany([])
    await relay.drain()
    expect(await loggedIds()).toEqual(before)

    const payload = (i: number) => ({ cartId: `cart-${i}`, itemCount: i, totalMinor: 0 })
    await publisher.publishMany([
      { type: EVT_CART_UPDATED, payload: payload(1), options: { correlationId: 'corr-explicit' } },
      { type: EVT_CART_UPDATED, payload: payload(2) },
    ])
    await relay.drain()

    expect(received.map((e) => e.payload)).toEqual([payload(1), payload(2)])
    expect(received.map((e) => e.correlationId)).toEqual(['corr-explicit', received[1]!.id])
    expect(await loggedIds()).toEqual([...before, ...received.map((e) => e.id)])
  })
})

describe('publishUntyped', () => {
  it('logs and returns each event as built with the options given, and delivers them in order after a pass', async () => {
    const before = await loggedIds()
    const at = new Date('2026-01-02T03:04:05.000Z')
    const built = await publisher.publishUntyped(
      [
        { type: UNTYPED, payload: { parcel: 'p-1' } },
        { type: UNTYPED, payload: { parcel: 'p-2' } },
      ],
      { correlationId: 'corr-untyped', source: 'acme-carrier', timestamp: at },
    )
    expect(built.map((e) => [e.type, e.payload, e.correlationId, e.source, e.timestamp])).toEqual([
      [UNTYPED, { parcel: 'p-1' }, 'corr-untyped', 'acme-carrier', at.toISOString()],
      [UNTYPED, { parcel: 'p-2' }, 'corr-untyped', 'acme-carrier', at.toISOString()],
    ])

    await relay.drain()
    expect(untyped.slice(-2)).toEqual(built)
    expect(await loggedIds()).toEqual([...before, ...built.map((e) => e.id)])
  })

  it('with no options, each event is its own correlation', async () => {
    const built = await publisher.publishUntyped([
      { type: UNTYPED, payload: { parcel: 'p-3' } },
      { type: UNTYPED, payload: { parcel: 'p-4' } },
    ])
    expect(built.map((e) => e.correlationId)).toEqual(built.map((e) => e.id))
    expect(new Set(built.map((e) => e.id)).size).toBe(2)
    await relay.drain()
  })

  it('an empty list returns nothing, logs nothing and asks for no pass, where one event asks for one', async () => {
    await relay.drain()
    const before = await loggedIds()
    const passes = vi.spyOn(relay, 'drain')

    expect(await publisher.publishUntyped([])).toEqual([])
    expect(passes).toHaveBeenCalledTimes(0)

    const [one] = await publisher.publishUntyped([{ type: UNTYPED, payload: { parcel: 'p-5' } }])
    expect(passes).toHaveBeenCalledTimes(1)
    await relay.drain()
    expect(await loggedIds()).toEqual([...before, one!.id])
  })
})
