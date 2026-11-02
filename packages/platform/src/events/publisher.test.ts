import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { createRelay } from './relay.js'

// publishMany: every event it is given is logged in one write and handed to the bus in order, each with its own
// options (an explicit correlation id is kept; with none the event is its own); an empty list logs nothing.

let store: CommandStore
let publisher: EventPublisher
const received: NymbalEvent<unknown>[] = []

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
  publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
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
    expect(await loggedIds()).toEqual(before)

    const payload = (i: number) => ({ cartId: `cart-${i}`, itemCount: i, totalMinor: 0 })
    await publisher.publishMany([
      { type: EVT_CART_UPDATED, payload: payload(1), options: { correlationId: 'corr-explicit' } },
      { type: EVT_CART_UPDATED, payload: payload(2) },
    ])

    expect(received.map((e) => e.payload)).toEqual([payload(1), payload(2)])
    expect(received.map((e) => e.correlationId)).toEqual(['corr-explicit', received[1]!.id])
    expect(await loggedIds()).toEqual([...before, ...received.map((e) => e.id)])
  })
})
