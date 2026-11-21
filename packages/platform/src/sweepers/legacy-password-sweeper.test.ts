import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommandStore, rawClients, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import { createAuthService, hashResetToken } from '../services/auth-service.js'
import { tagged, VECTORS } from '../services/fixtures/wordpress-vectors.js'
import { wirePublisher } from '../tests/publisher.js'
import { startLegacyPasswordSweeper } from './index.js'

// Past the store's sunset date a sweep replaces every WordPress hash still held with the no-password marker, so the
// weak hashes are not kept at rest and those shoppers use "Forgot password?". Before the date, or with none, it touches
// nothing; it never touches a native hash. It runs once at start and then each interval. The clock is faked (Date
// only); the store and the sweep run for real.

const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000
const T0 = Date.parse('2026-11-19T09:30:00.000Z')
const IMPORTED_NO_PASSWORD = 'IMPORTED_NO_PASSWORD'
const NATIVE = bcrypt.hashSync('native-correct-horse', 4)

type Kind = 'native' | 'sentinel' | 'tagged'

const opened: Array<{ store: CommandStore; stop: () => void }> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const o of opened.splice(0)) {
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
  const lines: string[] = []
  const logger = createLogger({
    pretty: false,
    level: 'info',
    destination: { write: (line: string) => void lines.push(line) },
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  // The sweep publishes customer.updated for each row it changes; the relay logs elsewhere, so `lines` is the sweep's.
  const quiet = createLogger({ pretty: false, level: 'silent' })
  const { publisher } = wirePublisher(
    { createEventPublisher, createRelay },
    {
      store,
      eventLog: repos.eventLog,
      eventBus: new InProcessEventBus({ logger: quiet }),
      logger: quiet,
    },
  )
  const handles: Array<{ stop: () => void }> = []
  opened.push({ store, stop: () => handles.forEach((h) => h.stop()) })
  const sweeper = (until: Date | undefined, intervalMs = 10 * 60_000) => {
    const handle = startLegacyPasswordSweeper({
      store,
      customers: repos.customer,
      publisher,
      logger,
      intervalMs,
      ...(until !== undefined && { until }),
    })
    handles.push(handle)
    return handle
  }
  return { store, repos, lines, logger, sweeper }
}

type Store = Awaited<ReturnType<typeof openStore>>

interface Seeded {
  id: string
  email: string
  kind: Kind
  stored: string
}

async function seed(s: Store, kinds: Kind[]): Promise<Seeded[]> {
  const rows: Seeded[] = kinds.map((kind, i) => ({
    id: randomUUID(),
    email: `${kind}-${i}-${randomUUID().slice(0, 6)}@sweep.test`,
    kind,
    stored:
      kind === 'native'
        ? NATIVE
        : kind === 'sentinel'
          ? IMPORTED_NO_PASSWORD
          : tagged(VECTORS[i % VECTORS.length]!.hash),
  }))
  const at = new Date(T0 - DAY_MS)
  await s.store.transaction(async (tx) => {
    for (const r of rows) {
      await s.repos.customer.insert(tx, {
        id: r.id,
        email: r.email,
        passwordHash: r.stored,
        requiresPasswordReset: r.kind !== 'native',
        createdAt: at,
        updatedAt: at,
      })
    }
  })
  return rows
}

function rows(s: Store): Map<string, Record<string, unknown>> {
  const clients = rawClients(s.store)
  if (clients.kind !== 'sqlite') throw new Error('this file runs on SQLite')
  const all = clients.raw.prepare('SELECT * FROM customers ORDER BY id').all() as Array<
    Record<string, unknown>
  >
  return new Map(all.map((r) => [String(r['id']), r]))
}

/**
 * Runs a tick to its end. The sweeper's own start tick may still hold the sweep, so the first tick may return at once;
 * after a turn of the event loop the start tick has settled, and the second runs for real.
 */
async function settled(sweeper: { tick: () => Promise<void> }): Promise<void> {
  await sweeper.tick()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await sweeper.tick()
}

/** The numbers a log line carries beside pino's own level, time and pid. */
function countsIn(line: string): number[] {
  return Object.entries(JSON.parse(line) as Record<string, unknown>)
    .filter(([key, value]) => typeof value === 'number' && !['level', 'time', 'pid'].includes(key))
    .map(([, value]) => value as number)
}

const kinds = fc.array(fc.constantFrom<Kind>('native', 'sentinel', 'tagged'), {
  minLength: 1,
  maxLength: 8,
})

describe('AC-12: the sunset sweep', () => {
  it('AC-12: before until, and with no until, a tick changes no row of a generated mix of native, sentinel and tagged rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await fc.assert(
      fc.asyncProperty(kinds, fc.integer({ min: 1, max: 365 * DAY_MS }), async (mix, ahead) => {
        vi.setSystemTime(T0)
        const s = await openStore()
        await seed(s, mix)
        const before = rows(s)
        await settled(s.sweeper(new Date(T0 + ahead)))
        await settled(s.sweeper(undefined))
        expect(rows(s)).toEqual(before)
      }),
      { numRuns: 10 },
    )
  }, 60_000)

  it('AC-12: at until and after, a tick makes every tagged row IMPORTED_NO_PASSWORD with the reset flag still set, leaves every other row byte-equal, logs one line carrying only the count (a tick that sweeps none may log a zero), and a second tick changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await fc.assert(
      fc.asyncProperty(
        kinds.filter((mix) => mix.includes('tagged')),
        fc.integer({ min: 0, max: 30 * DAY_MS }),
        async (mix, past) => {
          vi.setSystemTime(T0)
          const s = await openStore()
          const seeded = await seed(s, mix)
          const before = rows(s)
          const logged = s.lines.length
          const sweeper = s.sweeper(new Date(T0 - past))

          await settled(sweeper)
          const after = rows(s)
          await sweeper.tick()
          const tickLines = s.lines.slice(logged)

          const swept = seeded.filter((r) => r.kind === 'tagged')
          // A tagged row changes in its hash and its updated_at only; every other row not at all.
          const unchangedBut = (row: Record<string, unknown>, kind: Kind) => {
            if (kind !== 'tagged') return row
            const { password_hash: _h, updated_at: _u, ...rest } = row
            return rest
          }
          expect(seeded.map((r) => unchangedBut(after.get(r.id)!, r.kind))).toEqual(
            seeded.map((r) => unchangedBut(before.get(r.id)!, r.kind)),
          )
          expect(
            swept.map((r) => [
              after.get(r.id)!['password_hash'],
              Boolean(after.get(r.id)!['requires_password_reset']),
            ]),
          ).toEqual(swept.map(() => [IMPORTED_NO_PASSWORD, true]))
          expect(rows(s), 'the second tick').toEqual(after)
          const counting = tickLines.map(countsIn).filter((counts) => counts.some((n) => n > 0))
          expect(counting, tickLines.join('')).toEqual([[swept.length]])
          const leaked = seeded
            .flatMap((r) => [r.id, r.email, r.stored])
            .filter((v) => tickLines.some((l) => l.includes(v)))
          expect([leaked, tickLines.some((l) => l.includes('legacy:'))]).toEqual([[], false])
        },
      ),
      { numRuns: 10 },
    )
  }, 60_000)

  it('AC-12: started with an hour’s interval and until passed, the sweep has already run, well before the first interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const s = await openStore()
    const seeded = await seed(s, ['tagged', 'native', 'tagged'])
    s.sweeper(new Date(T0 - HOUR_MS), HOUR_MS)

    await vi.waitFor(
      () => {
        const now = rows(s)
        expect(seeded.map((r) => now.get(r.id)!['password_hash'])).toEqual([
          IMPORTED_NO_PASSWORD,
          NATIVE,
          IMPORTED_NO_PASSWORD,
        ])
      },
      { timeout: 2_000, interval: 20 },
    )
  })

  it('AC-12: after the sweep, the customer asks for a reset link and signs in with the password it sets; the WordPress password stays refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const s = await openStore()
    const v = VECTORS.find((x) => x.nymbalVerifies)!
    const [row] = await seed(s, ['tagged'])
    const { publisher } = wirePublisher(
      { createEventPublisher, createRelay },
      {
        store: s.store,
        eventLog: s.repos.eventLog,
        eventBus: new InProcessEventBus({ logger: s.logger }),
        logger: s.logger,
      },
    )
    const auth = createAuthService({
      repos: s.repos,
      publisher,
      logger: s.logger,
      jwtSecret: 'test-secret-32-characters-long-x',
      accessTtl: '15m',
      refreshTtl: '7d',
      legacy: { until: new Date(T0 - HOUR_MS), maxCost: 10 },
    })
    await settled(s.sweeper(new Date(T0 - HOUR_MS)))
    expect(rows(s).get(row!.id)!['password_hash']).toBe(IMPORTED_NO_PASSWORD)

    await auth.requestPasswordReset(row!.email)
    const token = randomUUID()
    await s.store.transaction((tx) =>
      s.repos.passwordResetToken.insert(tx, {
        id: randomUUID(),
        customerId: row!.id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(T0 + 15 * 60_000),
        createdAt: new Date(T0),
      }),
    )
    const reset = await auth.resetPassword(token, 'after-the-sunset')
    const signedIn = await auth.login(row!.email, 'after-the-sunset')
    const refused = await auth.login(row!.email, v.password).then(
      () => 'signed in',
      (error: Error) => error.message,
    )
    expect([reset.customer.id, signedIn.customer.id, refused]).toEqual([
      row!.id,
      row!.id,
      'Invalid email or password',
    ])
  })
})
