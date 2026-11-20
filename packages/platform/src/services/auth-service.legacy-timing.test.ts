import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from './auth-service.js'
import { vector } from './fixtures/wordpress-vectors.js'

// On a store that opted into cost-12 WordPress hashes, with the sunset window open, a refused sign-in for an imported
// WordPress customer takes as long as one for a known address: real bcrypt and real phpass, timed. A shared machine
// slows for seconds at a time, so the classes are timed in turn within each round, in an order that turns every round,
// and each is compared with the known address in the same round; the median over rounds of those ratios must sit
// within 0.4 to 2.5. What this sees that the counted ledger does not: work outside bcrypt, MD5 and the HMAC, such as a
// second database round trip on one class or phpass run twice.

const ROUNDS = 12
const LOWEST = 0.4
const HIGHEST = 2.5
const WRONG = 'legacy-timing-wrong-horse'
const DAY_MS = 24 * 60 * 60_000

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

async function timeMs(call: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  await call().catch(() => undefined)
  return performance.now() - start
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'signed in'
  } catch (error) {
    return error instanceof AuthError ? `${error.code}: ${error.message}` : `threw ${String(error)}`
  }
}

describe('AC-6: on an opted-in store, refusals for WordPress customers take a known address’s time', () => {
  it('AC-6: with maxCost 12 and the window open, over 12 rounds timed in turn, the median per-round ratio to a known address’s wrong password is 0.4 to 2.5 for legacy $P$B, $wp$2y$12$ and $2y$11$ wrong passwords, all with one code and message', async () => {
    const store = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    try {
      await runMigrations(store, {
        migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
      })
      const logger = createLogger({ pretty: false, level: 'error' })
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
        legacy: { until: new Date(Date.now() + 30 * DAY_MS), maxCost: 12 },
      })
      const known = `known-${randomUUID().slice(0, 8)}@timing.test`
      await auth.register({ email: known, password: 'known-correct-horse' })
      const legacy: Array<[string, string]> = []
      for (const name of ['phpass ascii', 'wp bcrypt 12 ascii', 'bcrypt 11 ascii']) {
        const email = `${name.replace(/\W+/g, '-')}-${randomUUID().slice(0, 8)}@timing.test`
        await auth.importCustomer({ email })
        expect(
          await auth.importLegacyPassword({ email, recipe: 'wordpress', hash: vector(name).hash }),
        ).toBe('stored')
        legacy.push([name, email])
      }
      const classes: Array<[string, string]> = [['known', known], ...legacy]
      // The first compare and the first phpass in a process pay for compilation; they are no sample.
      for (const [, email] of classes) await auth.login(email, WRONG).catch(() => undefined)

      const times = classes.map(() => [] as number[])
      for (let round = 0; round < ROUNDS; round += 1) {
        const order = classes.map((_, i) => (i + round) % classes.length)
        if (Math.floor(round / classes.length) % 2 === 1) order.reverse()
        for (const i of order) times[i]!.push(await timeMs(() => auth.login(classes[i]![1], WRONG)))
      }
      const knownTimes = times[0]!
      const ratios = legacy.map(([name], i) => ({
        name,
        ratio: median(times[i + 1]!.map((t, r) => t / knownTimes[r]!)),
        ms: median(times[i + 1]!),
      }))
      const refusals = await Promise.all(
        classes.map(([, email]) => refusalOf(auth.login(email, WRONG))),
      )

      const label = `median of ${ROUNDS} rounds: known ${median(knownTimes).toFixed(1)} ms; ${ratios
        .map((r) => `${r.name} ${r.ms.toFixed(1)} ms (${r.ratio.toFixed(2)}x)`)
        .join(', ')}`
      for (const { ratio } of ratios) {
        expect(ratio, label).toBeGreaterThanOrEqual(LOWEST)
        expect(ratio, label).toBeLessThanOrEqual(HIGHEST)
      }
      expect(refusals).toEqual(
        classes.map(() => 'auth.invalid_credentials: Invalid email or password'),
      )
    } finally {
      await store.close()
    }
  }, 180_000)
})
