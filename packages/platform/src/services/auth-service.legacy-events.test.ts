import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { EVT_CUSTOMER_UPDATED } from '@nymbalhq/types'
import { createCommandStore, rawClients, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import { startLegacyPasswordSweeper } from '../sweepers/index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from './auth-service.js'
import { vector } from './fixtures/wordpress-vectors.js'

// Each row an imported WordPress hash changes gets exactly one customer.updated: storing the hash, the upgrade on the
// first sign-in, and the sunset sweep, as a password reset does. A row the step leaves alone gets none. Real bcrypt and
// phpass on a SQLite command store; the events are read from the store's own log.

const DAY_MS = 24 * 60 * 60_000

const open: Array<{ store: CommandStore; stop: () => void }> = []
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.stop()
    await o.store.close()
  }
})

async function openStore() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'silent' })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const { publisher } = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
  )
  const auth = createAuthService({
    repos,
    publisher,
    logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m',
    refreshTtl: '7d',
    legacy: { until: new Date(Date.now() + 30 * DAY_MS), maxCost: 10 },
  })
  const sweeper = startLegacyPasswordSweeper({
    store,
    customers: repos.customer,
    publisher,
    logger,
    until: new Date(Date.now() - DAY_MS),
    intervalMs: 60 * 60_000,
  })
  open.push({ store, stop: () => sweeper.stop() })
  return { store, auth, sweeper }
}

/** customer.updated events in the log, by the customer each names. */
function updatesByCustomer(store: CommandStore): Map<string, number> {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error('this file runs on SQLite')
  const rows = clients.raw
    .prepare('SELECT envelope FROM events WHERE type = ?')
    .all(EVT_CUSTOMER_UPDATED) as Array<{ envelope: string }>
  const counts = new Map<string, number>()
  for (const { envelope } of rows) {
    const id = (JSON.parse(envelope) as { payload: { customerId: string } }).payload.customerId
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/** What each step added per customer, in the customers' order. */
function added(before: Map<string, number>, after: Map<string, number>, ids: string[]): number[] {
  return ids.map((id) => (after.get(id) ?? 0) - (before.get(id) ?? 0))
}

describe('one customer.updated per row an imported hash changes', () => {
  it('over generated sets of imported customers, storing the hash, upgrading on sign-in and the sunset sweep each publish exactly one customer.updated for every row they change and none for any other', async () => {
    const v = vector('phpass ascii')
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        async (signsIn, withBystander) => {
          const s = await openStore()
          // The start sweep runs as the sweeper starts; it has found no hash yet.
          await s.sweeper.tick()
          const customers = await Promise.all(
            signsIn.map(async () => {
              const email = `events-${randomUUID().slice(0, 8)}@legacy.test`
              return { id: (await s.auth.importCustomer({ email })).id, email }
            }),
          )
          const bystander = withBystander
            ? [
                (
                  await s.auth.importCustomer({
                    email: `none-${randomUUID().slice(0, 8)}@legacy.test`,
                  })
                ).id,
              ]
            : []
          const ids = [...customers.map((c) => c.id), ...bystander]

          const beforeImport = updatesByCustomer(s.store)
          for (const c of customers) {
            await s.auth.importLegacyPassword({ email: c.email, recipe: 'wordpress', hash: v.hash })
          }
          const afterImport = updatesByCustomer(s.store)
          for (const [i, c] of customers.entries()) {
            if (signsIn[i]) await s.auth.login(c.email, v.password)
          }
          const afterUpgrade = updatesByCustomer(s.store)
          await s.sweeper.tick()
          const afterSweep = updatesByCustomer(s.store)

          const none = bystander.map(() => 0)
          expect({
            imported: added(beforeImport, afterImport, ids),
            upgraded: added(afterImport, afterUpgrade, ids),
            swept: added(afterUpgrade, afterSweep, ids),
          }).toEqual({
            imported: [...customers.map(() => 1), ...none],
            upgraded: [...signsIn.map((signed) => (signed ? 1 : 0)), ...none],
            swept: [...signsIn.map((signed) => (signed ? 0 : 1)), ...none],
          })
        },
      ),
      { numRuns: 8 },
    )
  }, 120_000)
})
