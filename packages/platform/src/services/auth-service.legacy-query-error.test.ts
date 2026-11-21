import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { withoutQueryParams } from '../db/query-error.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import { renderError } from '../routes/envelope.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from './auth-service.js'
import { tagged, vector } from './fixtures/wordpress-vectors.js'

// On Postgres a failed statement throws drizzle's query error, whose message lists every bound value. The write that
// upgrades an imported WordPress customer binds the hash it replaces, so its failure must reach the log without it.
// The error is drizzle's own, from the upgrade's statement on a Postgres client whose connection drops.

const DAY_MS = 24 * 60 * 60_000

/** What drizzle throws when the upgrade's conditional write fails on Postgres, with `from` and `email` bound. */
async function failedUpgradeWrite(from: string, email: string): Promise<Error> {
  const client = {
    query: async () => {
      throw new Error('Connection terminated unexpectedly')
    },
  }
  const db = drizzle(client as never, { schema: postgresSchema })
  const t = postgresSchema.customers
  try {
    await db
      .update(t)
      .set({ passwordHash: '$2a$10$native', requiresPasswordReset: false, updatedAt: new Date(0) })
      .where(and(eq(t.email, email), eq(t.passwordHash, from)))
  } catch (err) {
    return err as Error
  }
  throw new Error('the statement did not fail')
}

const open: CommandStore[] = []
afterEach(async () => {
  for (const store of open.splice(0)) await store.close()
})

describe('a failed statement leaves without its bound values', () => {
  it('withoutQueryParams keeps the statement and the driver’s reason of drizzle’s error and drops the hash and email it bound; any other error is passed on as it is', async () => {
    const from = tagged(vector('phpass ascii').hash)
    const email = 'bound-value@legacy.test'
    const failed = await failedUpgradeWrite(from, email)
    expect([failed.message.includes(from), failed.message.includes(email)]).toEqual([true, true])

    const clean = withoutQueryParams(failed) as Error
    const text = JSON.stringify({ ...clean, message: clean.message, stack: clean.stack })
    expect({
      statement: clean.message.startsWith('Failed query: update "customers" set'),
      reason: clean.message.endsWith(': Connection terminated unexpectedly'),
      bound: [from, email, 'legacy:'].filter((value) => text.includes(value)),
    }).toEqual({ statement: true, reason: true, bound: [] })

    const other = new Error('something else')
    expect([withoutQueryParams(other), withoutQueryParams('text')]).toEqual([other, 'text'])
  })

  it('a legacy sign-in whose upgrade write fails rejects with an error that, logged at debug as a route logs it, carries neither the WordPress hash, the legacy: prefix nor the email', async () => {
    const store = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    open.push(store)
    await runMigrations(store, {
      migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
    })
    const lines: string[] = []
    const logger = createLogger({
      pretty: false,
      level: 'debug',
      destination: { write: (line: string) => void lines.push(line) },
    })
    const quiet = createLogger({ pretty: false, level: 'silent' })
    const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    const { publisher } = wirePublisher(
      { createEventPublisher, createRelay },
      {
        store,
        eventLog: repos.eventLog,
        eventBus: new InProcessEventBus({ logger: quiet }),
        logger: quiet,
      },
    )
    const v = vector('wp bcrypt 10 ascii')
    const email = `upgrade-${randomUUID().slice(0, 8)}@legacy.test`
    const failure = await failedUpgradeWrite(tagged(v.hash), email)
    const failing = {
      ...repos,
      customer: { ...repos.customer, replacePasswordHash: () => Promise.reject(failure) },
    }
    const auth = createAuthService({
      repos: failing,
      publisher,
      logger: quiet,
      jwtSecret: 'test-secret-32-characters-long-x',
      accessTtl: '15m',
      refreshTtl: '7d',
      legacy: { until: new Date(Date.now() + 30 * DAY_MS), maxCost: 10 },
    })
    const { id } = await auth.importCustomer({ email })
    // importLegacyPassword writes through the failing statement, so the hash is put in place directly.
    await store.transaction((tx) =>
      repos.customer.update(tx, id, { passwordHash: tagged(v.hash), updatedAt: new Date() }),
    )

    const rejected = await auth.login(email, v.password).then(
      () => new Error('signed in'),
      (err: unknown) => err,
    )
    renderError(rejected, logger)

    const logged = lines.join('')
    expect({
      failedQuery: logged.includes('Failed query: update'),
      reason: logged.includes('Connection terminated unexpectedly'),
      bound: [v.hash, 'legacy:', email].filter((value) => logged.includes(value)),
      row: (await store.read((tx) => repos.customer.findById(tx, id)))?.passwordHash,
    }).toEqual({ failedQuery: true, reason: true, bound: [], row: tagged(v.hash) })
  })
})
