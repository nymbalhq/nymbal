import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from './auth-service.js'
import { createLogger } from '../logger.js'

// A refresh token is good for one rotation, and for re-rotation within 30 s of its first rotation (two tabs that
// present one cookie together). The window is anchored at that first rotation and never slides. Presented after it,
// a rotated token ends every session of its customer. A token revoked by logout is a plain refusal. The clock is
// faked (Date only); the store and hashing run for real.

const WINDOW_MS = 30_000
const T0 = Date.parse('2026-06-01T09:00:00.000Z')
const PASSWORD = 'password123'

async function setup() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
  const auth = createAuthService({
    repos,
    publisher,
    logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m',
    refreshTtl: '7d',
  })
  return { auth, commandStore }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** `ok` when the promise resolves, else the AuthError's code. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (error) {
    return error instanceof AuthError ? error.code : `threw ${String(error)}`
  }
}

/** A customer signed in on two devices: `first` from registering, `second` from a login of its own. */
async function customerOnTwoDevices(auth: Setup['auth']) {
  const email = `reuse-${randomUUID()}@test.com`
  const { tokens } = await auth.register({ email, password: PASSWORD })
  const second = await auth.login(email, PASSWORD)
  return { first: tokens.refreshToken, second: second.tokens.refreshToken }
}

let s: Setup

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 })
  s = await setup()
})

afterEach(async () => {
  vi.useRealTimers()
  await s.commandStore.close()
})

describe('AC-15: a rotated token presented after the window ends every session', () => {
  it('AC-15: over chains R0 → … → Rk (k in 1..5) and i < k, Ri presented after the window is refused, and then Rk and the customer’s other device are refused; a token revoked by logout is refused and revokes nothing', async () => {
    let start = T0
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 1, max: 5 })
          .chain((k) => fc.tuple(fc.constant(k), fc.integer({ min: 0, max: k - 1 }))),
        async ([k, i]) => {
          start += 10 * WINDOW_MS
          vi.setSystemTime(start)
          const { first, second } = await customerOnTwoDevices(s.auth)
          const chain = [first]
          for (let j = 1; j <= k; j++) {
            chain.push((await s.auth.refresh(chain[j - 1]!)).refreshToken)
          }

          vi.setSystemTime(start + WINDOW_MS + 1000)
          const replay = await outcomeOf(s.auth.refresh(chain[i]!))
          const after = [
            await outcomeOf(s.auth.refresh(chain[k]!)),
            await outcomeOf(s.auth.refresh(second)),
          ]

          expect(replay, `R${i} of ${k}`).toBe('auth.token_invalid')
          expect(after, `R${k} and the other device after R${i} was replayed`).toEqual([
            'auth.token_invalid',
            'auth.token_invalid',
          ])
        },
      ),
      { numRuns: 20 },
    )

    vi.setSystemTime(start + 100 * WINDOW_MS)
    const { first, second } = await customerOnTwoDevices(s.auth)
    await s.auth.logout(first)
    const refused = [await outcomeOf(s.auth.refresh(first))]
    vi.setSystemTime(start + 100 * WINDOW_MS + WINDOW_MS + 1000)
    refused.push(await outcomeOf(s.auth.refresh(first)))
    const other = await outcomeOf(s.auth.refresh(second))

    expect(refused).toEqual(['auth.token_invalid', 'auth.token_invalid'])
    expect(other).toBe('ok')
  }, 60_000)

  it('AC-15: the window does not slide: R0 rotated at t0 and replayed at t0+20 s is answered, replayed again at t0+40 s it is refused and every session of the customer is refused', async () => {
    const { first: r0, second } = await customerOnTwoDevices(s.auth)
    const r1 = (await s.auth.refresh(r0)).refreshToken

    vi.setSystemTime(T0 + 20_000)
    const atTwenty = await s.auth.refresh(r0).then(
      (tokens) => tokens.refreshToken,
      (error: unknown) => `refused: ${String(error)}`,
    )
    vi.setSystemTime(T0 + 40_000)
    const atForty = await outcomeOf(s.auth.refresh(r0))
    const sessions = [
      await outcomeOf(s.auth.refresh(r1)),
      await outcomeOf(s.auth.refresh(atTwenty)),
      await outcomeOf(s.auth.refresh(second)),
    ]

    expect(atTwenty).not.toBe(r1)
    expect(atTwenty.startsWith('refused'), atTwenty).toBe(false)
    expect(atForty).toBe('auth.token_invalid')
    expect(sessions).toEqual(['auth.token_invalid', 'auth.token_invalid', 'auth.token_invalid'])
  })

  it('AC-15: a sign-out of every session does not reopen a rotated token’s window: R0 rotated at a, every session revoked at a+g by a replay on the other device, R0 replayed after a+30 s but within 30 s of the revoke is refused', async () => {
    let start = T0
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 1_000, max: WINDOW_MS - 1_000 })
          .chain((g) => fc.tuple(fc.constant(g), fc.integer({ min: 1, max: g }))),
        async ([g, d]) => {
          start += 10 * WINDOW_MS
          vi.setSystemTime(start)
          const { first: r0, second: s0 } = await customerOnTwoDevices(s.auth)
          await s.auth.refresh(s0)

          const rotatedAt = start + WINDOW_MS + 1
          vi.setSystemTime(rotatedAt)
          await s.auth.refresh(r0)

          vi.setSystemTime(rotatedAt + g)
          const theft = await outcomeOf(s.auth.refresh(s0))

          const replayAt = rotatedAt + WINDOW_MS + d
          vi.setSystemTime(replayAt)
          const replay = await outcomeOf(s.auth.refresh(r0))

          expect(theft, 'the other device’s stale token').toBe('auth.token_invalid')
          expect(
            replay,
            `R0 replayed ${replayAt - rotatedAt} ms after its rotation, ${replayAt - rotatedAt - g} ms after the revoke`,
          ).toBe('auth.token_invalid')
        },
      ),
      { numRuns: 10 },
    )
  }, 60_000)
})

describe('AC-16: a concurrent refresh is not a theft', () => {
  it('AC-16: two refresh(R0) in flight together and a replay of R0 10 s after its rotation each answer a fresh pair; each returned token refreshes again and the customer’s other device keeps its session', async () => {
    const { first: r0, second } = await customerOnTwoDevices(s.auth)

    const together = await Promise.allSettled([s.auth.refresh(r0), s.auth.refresh(r0)])
    vi.setSystemTime(T0 + 10_000)
    const replayed = await Promise.allSettled([s.auth.refresh(r0)])
    const answers = [...together, ...replayed]
    const pairs = answers.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : []))

    expect(answers.map((a) => (a.status === 'fulfilled' ? 'ok' : String(a.reason)))).toEqual([
      'ok',
      'ok',
      'ok',
    ])
    const refreshTokens = pairs.map((p) => p.refreshToken)
    expect(new Set([r0, ...refreshTokens]).size).toBe(refreshTokens.length + 1)
    expect(pairs.every((p) => p.accessToken.split('.').length === 3)).toBe(true)

    vi.setSystemTime(T0 + 20_000)
    const again = []
    for (const token of refreshTokens) again.push(await outcomeOf(s.auth.refresh(token)))
    const other = await outcomeOf(s.auth.refresh(second))

    expect(again).toEqual(refreshTokens.map(() => 'ok'))
    expect(other).toBe('ok')
  })
})
