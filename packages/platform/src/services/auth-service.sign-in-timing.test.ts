import { performance } from 'node:perf_hooks'
import bcrypt from 'bcryptjs'
import { describe, expect, it } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { createCommandStore, rawClients } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import { wirePublisher } from '../tests/publisher.js'
import {
  createAuthService,
  DUMMY_PASSWORD,
  DUMMY_PASSWORD_HASH,
  PASSWORD_HASH_ROUNDS,
} from './auth-service.js'

// A sign-in answers alike for a known address, an unknown one and an imported one with no password: each spends one
// bcrypt round at the store's cost, against the customer's hash or a dummy at the same cost, and each refuses with the
// one message. The dummy is published with the code, so its password signs nobody in, an imported customer included.
// Timings are real bcrypt at the real cost, five runs each, compared by median.

const PASSWORD = 'sign-in-timing-correct-horse'
const WRONG = 'sign-in-timing-wrong-horse'
const RUNS = 5
const LOWEST = 0.4
const HIGHEST = 2.5

async function setup() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const { publisher } = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  )
  const auth = createAuthService({
    repos,
    publisher,
    logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m',
    refreshTtl: '7d',
  })
  const refreshRows = (): number => {
    const clients = rawClients(commandStore)
    if (clients.kind !== 'sqlite') throw new Error('this file runs on SQLite')
    return (clients.raw.prepare('SELECT count(*) AS n FROM refresh_tokens').get() as { n: number })
      .n
  }
  return { auth, repos, commandStore, refreshRows }
}

/** What a rejected sign-in carried: the AuthError's code and message, or what else it threw. */
async function refusalOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
    return { code: 'signed in', message: '' }
  } catch (error) {
    if (error instanceof AuthError) return { code: error.code, message: error.message }
    return { code: `threw ${String(error)}`, message: '' }
  }
}

/** The median wall time of `runs` calls, each awaited to its settlement. */
async function medianMs(call: () => Promise<unknown>, runs = RUNS): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    await call().catch(() => undefined)
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(runs / 2)]!
}

describe('AC-1: a sign-in answers in one time and one message for known, unknown and imported addresses', () => {
  it('AC-1: over real bcrypt at the real cost, the median sign-in time for an unknown address and for an imported customer is 0.4 to 2.5 times that for a known address with a wrong password, and all three refuse auth.invalid_credentials with one message', async () => {
    const { auth, commandStore } = await setup()
    try {
      await auth.register({ email: 'known@timing.test', password: PASSWORD })
      await auth.importCustomer({ email: 'imported@timing.test' })
      // The first compare in a process pays for compilation; it is no sample.
      await auth.login('known@timing.test', WRONG).catch(() => undefined)

      const known = await medianMs(() => auth.login('known@timing.test', WRONG))
      const unknown = await medianMs(() => auth.login('nobody@timing.test', WRONG))
      const imported = await medianMs(() => auth.login('imported@timing.test', WRONG))
      const refusals = [
        await refusalOf(auth.login('known@timing.test', WRONG)),
        await refusalOf(auth.login('nobody@timing.test', WRONG)),
        await refusalOf(auth.login('imported@timing.test', WRONG)),
      ]

      const ratios = { unknown: unknown / known, imported: imported / known }
      const label = `known ${known.toFixed(1)} ms, unknown ${unknown.toFixed(1)} ms, imported ${imported.toFixed(1)} ms`
      expect(ratios.unknown, label).toBeGreaterThanOrEqual(LOWEST)
      expect(ratios.unknown, label).toBeLessThanOrEqual(HIGHEST)
      expect(ratios.imported, label).toBeGreaterThanOrEqual(LOWEST)
      expect(ratios.imported, label).toBeLessThanOrEqual(HIGHEST)
      expect(refusals.map((r) => r.code)).toEqual(refusals.map(() => 'auth.invalid_credentials'))
      expect(new Set(refusals.map((r) => r.message)).size).toBe(1)
    } finally {
      await commandStore.close()
    }
  }, 60_000)

  it('AC-1: the dummy hash is a hash of DUMMY_PASSWORD at PASSWORD_HASH_ROUNDS, the cost a registered customer’s stored hash has', async () => {
    const { auth, repos, commandStore } = await setup()
    try {
      await auth.register({ email: 'rounds@timing.test', password: PASSWORD })
      const stored = await commandStore.read((tx) =>
        repos.customer.findByEmail(tx, 'rounds@timing.test'),
      )

      expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(PASSWORD_HASH_ROUNDS)
      expect(bcrypt.getRounds(stored!.passwordHash)).toBe(bcrypt.getRounds(DUMMY_PASSWORD_HASH))
      expect(await bcrypt.compare(DUMMY_PASSWORD, DUMMY_PASSWORD_HASH)).toBe(true)
    } finally {
      await commandStore.close()
    }
  }, 30_000)
})

describe('AC-2: the dummy password signs nobody in', () => {
  it('AC-2: login with DUMMY_PASSWORD at an unknown address and at an imported customer refuses auth.invalid_credentials and issues no refresh token; a known customer’s right password still signs in and issues one', async () => {
    const { auth, commandStore, refreshRows } = await setup()
    try {
      expect(DUMMY_PASSWORD, 'DUMMY_PASSWORD is exported').toEqual(expect.any(String))
      await auth.register({ email: 'owner@dummy.test', password: PASSWORD })
      await auth.importCustomer({ email: 'imported@dummy.test' })
      const before = refreshRows()

      const refusals = [
        await refusalOf(auth.login('nobody@dummy.test', DUMMY_PASSWORD)),
        await refusalOf(auth.login('imported@dummy.test', DUMMY_PASSWORD)),
      ]
      const afterRefusals = refreshRows()
      const owner = await auth.login('owner@dummy.test', PASSWORD)

      expect(refusals.map((r) => r.code)).toEqual([
        'auth.invalid_credentials',
        'auth.invalid_credentials',
      ])
      expect(afterRefusals).toBe(before)
      expect(owner.customer.email).toBe('owner@dummy.test')
      expect(refreshRows()).toBe(afterRefusals + 1)
    } finally {
      await commandStore.close()
    }
  }, 30_000)
})
