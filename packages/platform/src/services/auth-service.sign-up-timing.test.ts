import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from './auth-service.js'

// Under `required` a sign-up answers in one time whatever the address: it hashes the password at the store's cost on
// every path, before it looks the address up, so a taken address (pending or confirmed) is not answered a bcrypt round
// sooner than a new one. Timings are real bcrypt at the real cost, five runs each, compared by median.

const PASSWORD = 'sign-up-timing-correct-horse'
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
    verification: 'required',
  })
  return { auth, repos, commandStore }
}

/** The median wall time of `runs` calls, each awaited to its settlement. */
async function medianMs(call: (run: number) => Promise<unknown>, runs = RUNS): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    await call(i).catch(() => undefined)
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(runs / 2)]!
}

/** How a call settled: resolved, or what it threw. */
async function settlementOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'resolved'
  } catch (error) {
    return `threw ${String(error)}`
  }
}

describe('AC-3: a sign-up spends one bcrypt round whatever the address', () => {
  // Defect: the existing path skips the hash, so the 202 comes back a bcrypt round sooner for a taken address.
  it('AC-3: over real bcrypt at the real cost, the median signUp time for a pending address and for a confirmed address is each 0.4 to 2.5 times that for a new address, and all three resolve', async () => {
    const { auth, repos, commandStore } = await setup()
    try {
      await auth.signUp({ email: 'pending@timing.test', password: PASSWORD })
      await auth.signUp({ email: 'confirmed@timing.test', password: PASSWORD })
      const confirmedRow = await commandStore.read((tx) =>
        repos.customer.findByEmail(tx, 'confirmed@timing.test'),
      )
      await auth.markVerified(confirmedRow!.id)
      // The first hash in a process pays for compilation; it is no sample.
      await auth.signUp({ email: 'warm-up@timing.test', password: PASSWORD })

      const fresh = await medianMs((run) =>
        auth.signUp({ email: `new-${run}@timing.test`, password: PASSWORD }),
      )
      const pending = await medianMs(() =>
        auth.signUp({ email: 'pending@timing.test', password: PASSWORD }),
      )
      const confirmed = await medianMs(() =>
        auth.signUp({ email: 'confirmed@timing.test', password: PASSWORD }),
      )
      const settlements = [
        await settlementOf(auth.signUp({ email: 'one-more@timing.test', password: PASSWORD })),
        await settlementOf(auth.signUp({ email: 'pending@timing.test', password: PASSWORD })),
        await settlementOf(auth.signUp({ email: 'confirmed@timing.test', password: PASSWORD })),
      ]

      const label = `new ${fresh.toFixed(1)} ms, pending ${pending.toFixed(1)} ms, confirmed ${confirmed.toFixed(1)} ms`
      expect(pending / fresh, label).toBeGreaterThanOrEqual(LOWEST)
      expect(pending / fresh, label).toBeLessThanOrEqual(HIGHEST)
      expect(confirmed / fresh, label).toBeGreaterThanOrEqual(LOWEST)
      expect(confirmed / fresh, label).toBeLessThanOrEqual(HIGHEST)
      expect(settlements).toEqual(['resolved', 'resolved', 'resolved'])
    } finally {
      await commandStore.close()
    }
  }, 60_000)
})
