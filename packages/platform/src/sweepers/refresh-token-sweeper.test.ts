import { randomUUID } from 'node:crypto'
import { count } from 'drizzle-orm'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore, sqliteDb } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import { buildRepositories } from '../repositories/index.js'
import type { RefreshTokenInsert, RefreshTokenRow } from '../repositories/refresh-token.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from '../services/auth-service.js'
import { createLogger } from '../logger.js'
import { startRefreshTokenSweeper } from './index.js'

// The refresh-token sweeper keeps the table to about one row per session: a tick deletes expired rows and rotated rows
// whose 30 s reuse window has ended, and nothing a refresh could still answer differently. Heads, rotated rows inside
// their window and rows revoked by logout stay. The clock is faked (Date only, or Date and timers for stop()); the
// store, the hashing and the auth service run for real.

const WINDOW_MS = 30_000
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const T0 = Date.parse('2026-06-01T09:00:00.000Z')
const PASSWORD = 'password123'

async function setup(intervalMs = 10 * 60_000) {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'error' })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
  ).publisher
  const auth = createAuthService({
    repos,
    publisher,
    logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m',
    refreshTtl: '7d',
  })
  const sweeper = startRefreshTokenSweeper({
    store,
    refreshTokens: repos.refreshToken,
    logger,
    intervalMs,
  })
  return {
    store,
    repo: repos.refreshToken,
    auth,
    sweeper,
    async close() {
      sweeper.stop()
      await store.close()
    },
  }
}

type Env = Awaited<ReturnType<typeof setup>>

const rowCount = (env: Env): Promise<number> =>
  env.store.read(
    async (tx) =>
      sqliteDb(tx).select({ n: count() }).from(sqliteSchema.refreshTokens).get()?.n ?? -1,
  )

const readRows = (env: Env, ids: string[]): Promise<(RefreshTokenRow | null)[]> =>
  env.store.read(async (tx) => {
    const out: (RefreshTokenRow | null)[] = []
    for (const id of ids) out.push(await env.repo.findById(tx, id))
    return out
  })

/** `ok` when the promise resolves, else the AuthError's code. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (error) {
    return error instanceof AuthError ? error.code : `threw ${String(error)}`
  }
}

/** The jti a refresh token carries, read from its payload without verifying it. */
function jtiOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
    jti: string
  }
  return payload.jti
}

/** One customer signed in on `devices` devices: the first by registering, each other by a login of its own. */
async function signedIn(auth: Env['auth'], devices: number): Promise<string[]> {
  const email = `sweep-${randomUUID()}@test.com`
  const tokens = [(await auth.register({ email, password: PASSWORD })).tokens.refreshToken]
  for (let d = 1; d < devices; d++) {
    tokens.push((await auth.login(email, PASSWORD)).tokens.refreshToken)
  }
  return tokens
}

let env: Env | undefined

afterEach(async () => {
  vi.useRealTimers()
  await env?.close()
  env = undefined
})

type Kind = 'head' | 'rotated' | 'logout'

describe('AC-3: one tick deletes expired rows and rotated rows past their window, and nothing else', () => {
  it('AC-3: property: a tick at t deletes exactly the rows expired before t and the rotated rows revoked before t − 30 s, leaves every other row as it was, and a second tick deletes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 })
    env = await setup()
    const e = env
    const near = (edge: number) =>
      fc.oneof(
        fc.constantFrom(edge - 1, edge, edge + 1),
        fc.integer({ min: edge - 2 * HOUR_MS, max: edge + 2 * HOUR_MS }),
      )
    const arbRow = fc.record({
      kind: fc.constantFrom<Kind>('head', 'rotated', 'logout'),
      // Relative to the tick at t: revoked around t − 30 s, expiring around t.
      revokedAt: near(-WINDOW_MS).map((ms) => Math.min(ms, 0)),
      expiresAt: near(0),
    })
    let t = T0 + DAY_MS
    await fc.assert(
      fc.asyncProperty(fc.array(arbRow, { minLength: 1, maxLength: 12 }), async (specs) => {
        t += 10 * DAY_MS
        const customerId = randomUUID()
        const insert = (spec: (typeof specs)[number]): RefreshTokenInsert => ({
          id: uuidv7(),
          customerId,
          tokenHash: uuidv7(),
          createdAt: new Date(t - DAY_MS),
          expiresAt: new Date(t + spec.expiresAt),
        })
        // Every row of an earlier run expired at least 9 days before t; none of this run's expires before t − 2 h.
        await e.store.transaction((tx) => e.repo.purgeExpired(tx, new Date(t - 2 * DAY_MS)))
        const rows = specs.map((spec) => ({ spec, token: insert(spec) }))
        vi.setSystemTime(t - DAY_MS)
        await e.store.transaction(async (tx) => {
          for (const { token } of rows) await e.repo.insert(tx, token)
        })
        const successors: { id: string; expiresAt: number }[] = []
        for (const { spec, token } of rows) {
          if (spec.kind === 'head') continue
          vi.setSystemTime(t + spec.revokedAt)
          if (spec.kind === 'logout') {
            await e.store.transaction((tx) => e.repo.revoke(tx, token.id))
          } else {
            const next = { ...insert(spec), expiresAt: new Date(t + DAY_MS) }
            successors.push({ id: next.id, expiresAt: next.expiresAt.getTime() })
            await e.store.transaction((tx) => e.repo.rotate(tx, token.id, next))
          }
        }

        const ids = [...rows.map((r) => r.token.id), ...successors.map((s) => s.id)]
        const goes = [
          ...rows.map(
            ({ spec }) =>
              spec.expiresAt < 0 || (spec.kind === 'rotated' && spec.revokedAt < -WINDOW_MS),
          ),
          ...successors.map(() => false),
        ]
        const before = await readRows(e, ids)
        const totalBefore = await rowCount(e)

        vi.setSystemTime(t)
        await e.sweeper.tick()
        const afterFirst = await readRows(e, ids)
        const totalAfterFirst = await rowCount(e)
        await e.sweeper.tick()
        const totalAfterSecond = await rowCount(e)

        expect(
          afterFirst.map((row) => row === null),
          `deleted by the tick: ${JSON.stringify(specs)}`,
        ).toEqual(goes)
        expect(
          afterFirst.filter((row) => row !== null),
          'every row left is as it was before the tick',
        ).toEqual(before.filter((_, i) => !goes[i]))
        expect(totalAfterFirst, 'the rows the tick deleted, counted in the table').toBe(
          totalBefore - goes.filter(Boolean).length,
        )
        expect(totalAfterSecond, 'a second tick at the same instant').toBe(totalAfterFirst)
      }),
      {
        numRuns: 40,
        examples: [
          [
            [
              { kind: 'rotated', revokedAt: -WINDOW_MS - 1, expiresAt: 1 },
              { kind: 'rotated', revokedAt: -WINDOW_MS, expiresAt: 1 },
              { kind: 'logout', revokedAt: -HOUR_MS, expiresAt: 1 },
              { kind: 'head', revokedAt: 0, expiresAt: -1 },
              { kind: 'head', revokedAt: 0, expiresAt: 0 },
            ],
          ],
        ],
      },
    )
  }, 60_000)

  it('AC-3: refresh(R0) 10 s after R0’s rotation, then a tick, then refresh(R0) again: both answer a fresh pair, each new token refreshes, and the customer’s other device keeps its session', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 })
    env = await setup()
    const [r0, other] = await signedIn(env.auth, 2)
    const r1 = (await env.auth.refresh(r0!)).refreshToken

    /** The refresh token of the pair, or `refused: <reason>`. */
    const presentR0 = () =>
      env!.auth.refresh(r0!).then(
        (pair) => pair.refreshToken,
        (error: unknown) => `refused: ${String(error)}`,
      )
    vi.setSystemTime(T0 + 10_000)
    const first = await presentR0()
    await env.sweeper.tick()
    const second = await presentR0()

    expect(
      [first, second].filter((answer) => answer.startsWith('refused')),
      'R0 presented twice inside its window, with a tick between',
    ).toEqual([])
    expect(new Set([r0, r1, first, second]).size, 'each answer is a new token').toBe(4)

    vi.setSystemTime(T0 + 20_000)
    const again = [
      await outcomeOf(env.auth.refresh(first)),
      await outcomeOf(env.auth.refresh(second)),
      await outcomeOf(env.auth.refresh(other!)),
    ]
    expect(again, 'both new tokens and the other device').toEqual(['ok', 'ok', 'ok'])
  })

  it('AC-3: a token revoked by logout and presented after a tick is refused, and the customer’s other device still refreshes', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 })
    env = await setup()
    const [loggedOut, other] = await signedIn(env.auth, 2)
    await env.auth.logout(loggedOut!)
    const rowsBefore = await rowCount(env)

    vi.setSystemTime(T0 + HOUR_MS)
    await env.sweeper.tick()
    const presented = await outcomeOf(env.auth.refresh(loggedOut!))
    const otherDevice = await outcomeOf(env.auth.refresh(other!))

    expect({ presented, otherDevice }).toEqual({
      presented: 'auth.token_invalid',
      otherDevice: 'ok',
    })
    expect(await rowCount(env), 'the other device rotated: one row more than before').toBe(
      rowsBefore + 1,
    )
  })

  it('AC-3: after stop() no tick runs: an expired row inserted after stop is still there ten intervals later', async () => {
    const intervalMs = 60_000
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      now: T0,
    })
    env = await setup(intervalMs)
    const e = env
    const expiredRow = (): RefreshTokenInsert => ({
      id: uuidv7(),
      customerId: randomUUID(),
      tokenHash: uuidv7(),
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      expiresAt: new Date(Date.now() - HOUR_MS),
    })
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

    const swept = expiredRow()
    await e.store.transaction((tx) => e.repo.insert(tx, swept))
    await vi.advanceTimersByTimeAsync(intervalMs)
    await vi.waitFor(async () => {
      expect(await readRows(e, [swept.id]), 'a running sweeper deletes it').toEqual([null])
    })

    e.sweeper.stop()
    const kept = expiredRow()
    await e.store.transaction((tx) => e.repo.insert(tx, kept))
    await vi.advanceTimersByTimeAsync(10 * intervalMs)
    await settle()

    expect((await readRows(e, [kept.id]))[0]?.id, 'ten intervals after stop()').toBe(kept.id)
    const purgedByHand = await e.store.transaction((tx) => e.repo.purgeExpired(tx, new Date()))
    expect(purgedByHand, 'what the stopped sweeper left for purgeExpired').toBe(1)
  })
})

/** How many devices one customer uses, and the (hour, device) pairs whose first refresh of the hour is two tabs at once. */
interface WeekPlan {
  devices: number
  bursts: { hour: number; device: number }[]
}

const WEEK_HOURS = 7 * 24
const DAY6_HOUR = 6 * 24

interface WeekResult {
  env: Env
  latest: string[]
  day6Token: string
  /** Per hourly tick: the rows left and the bound they must stay under. */
  ticks: { hour: number; rows: number; bound: number }[]
  finalRows: number
}

/**
 * A week of page views at `perHour` refreshes per device per hour, each with that device's latest token, and a sweeper
 * tick at the end of every hour. Refreshes land in each hour's first 59 minutes, none in the 30 s before its tick.
 */
async function simulateWeek(plan: WeekPlan, perHour: number): Promise<WeekResult> {
  vi.setSystemTime(T0)
  const env = await setup()
  const latest = await signedIn(env.auth, plan.devices)
  const bursts = new Set(plan.bursts.map((b) => `${b.hour}:${b.device}`))
  const step = Math.floor((HOUR_MS - 100_000) / perHour)
  const rotatedAt: number[] = []
  const ticks: WeekResult['ticks'] = []
  let orphaned = 0
  let day6Token = ''

  const refreshAt = async (at: number, d: number) => {
    vi.setSystemTime(at)
    const presented = latest[d]!
    const pair = await env.auth.refresh(presented)
    rotatedAt.push(at)
    return { presented, next: pair.refreshToken }
  }

  for (let hour = 0; hour < WEEK_HOURS; hour++) {
    const start = T0 + hour * HOUR_MS
    for (let j = 0; j < perHour; j++) {
      for (let d = 0; d < plan.devices; d++) {
        const at = start + 60_000 + j * step + d * 1000
        const { presented, next } = await refreshAt(at, d)
        if (hour === DAY6_HOUR && j === 0 && d === 0) day6Token = presented
        latest[d] = next
        if (j === 0 && bursts.has(`${hour}:${d}`)) {
          // The second tab presents the same cookie 5 s later; the browser keeps the second answer.
          vi.setSystemTime(at + 5000)
          latest[d] = (await env.auth.refresh(presented)).refreshToken
          orphaned += 1
        }
      }
    }
    const tickAt = start + HOUR_MS
    vi.setSystemTime(tickAt)
    await env.sweeper.tick()
    const recent = rotatedAt.filter((at) => at >= tickAt - WINDOW_MS).length
    ticks.push({ hour, rows: await rowCount(env), bound: plan.devices + orphaned + recent })
  }
  return { env, latest, day6Token, ticks, finalRows: ticks[ticks.length - 1]!.rows }
}

describe('AC-4: the table stays bounded by sessions, not refreshes', () => {
  it('AC-4: property: over a week of page views with a tick every hour, the rows after each tick stay within live heads + orphaned heads + rotations in the last 30 s, the end-of-week count is the same at n and 10n refreshes per hour, and a token rotated on day 6 presented on day 7 is refused and ends every device’s session', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 })
    const arbPlan = fc.integer({ min: 1, max: 3 }).chain((devices) =>
      fc.record({
        devices: fc.constant(devices),
        n: fc.integer({ min: 1, max: 3 }),
        bursts: fc.uniqueArray(
          fc.record({
            hour: fc.integer({ min: 0, max: WEEK_HOURS - 1 }),
            device: fc.integer({ min: 0, max: devices - 1 }),
          }),
          { maxLength: 4, selector: (b) => `${b.hour}:${b.device}` },
        ),
      }),
    )
    await fc.assert(
      fc.asyncProperty(arbPlan, async (plan) => {
        const slow = await simulateWeek(plan, plan.n)
        const fast = await simulateWeek(plan, 10 * plan.n)
        try {
          const over = (r: WeekResult) => r.ticks.filter((t) => t.rows > t.bound)
          expect(over(slow), `ticks over the bound at ${plan.n}/h`).toEqual([])
          expect(over(fast), `ticks over the bound at ${10 * plan.n}/h`).toEqual([])
          expect(
            fast.finalRows,
            `rows at the end of the week, ${10 * plan.n}/h against ${plan.n}/h`,
          ).toBe(slow.finalRows)

          // Day 7: the token device 0 presented in the first hour of day 6 comes back.
          vi.setSystemTime(T0 + WEEK_HOURS * HOUR_MS + 60_000)
          const [day6Row] = await readRows(slow.env, [jtiOf(slow.day6Token)])
          const replay = await outcomeOf(slow.env.auth.refresh(slow.day6Token))
          const devicesAfter: string[] = []
          for (const token of slow.latest)
            devicesAfter.push(await outcomeOf(slow.env.auth.refresh(token)))

          expect(
            { day6Row, replay, devicesAfter },
            'the day-6 token, purged by the hourly ticks, presented on day 7',
          ).toEqual({
            day6Row: null,
            replay: 'auth.token_invalid',
            devicesAfter: slow.latest.map(() => 'auth.token_invalid'),
          })
        } finally {
          await slow.env.close()
          await fast.env.close()
        }
      }),
      // Each run simulates two weeks (n and 10n): about 0.25 ms a refresh, up to 16 600 refreshes a run.
      {
        numRuns: 2,
        examples: [
          [
            {
              devices: 2,
              n: 2,
              bursts: [
                { hour: 10, device: 1 },
                { hour: DAY6_HOUR, device: 0 },
              ],
            },
          ],
        ],
      },
    )
  }, 300_000)
})
