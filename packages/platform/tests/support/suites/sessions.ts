import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import { decodeJwt } from 'jose'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthError, type CustomerSession } from '@nymbalhq/types'
import { createCommandStore, type CommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../../src/event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../../../src/index.js'
import { createLogger } from '../../../src/logger.js'
import { buildRepositories, type Repositories } from '../../../src/repositories/index.js'
import { createAuthService, hashResetToken } from '../../../src/services/auth-service.js'
import { startRefreshTokenSweeper } from '../../../src/sweepers/refresh-token-sweeper.js'
import type { SweeperHandle } from '../../../src/sweepers/inventory-reservation-sweeper.js'
import { wirePublisher } from '../../../src/tests/publisher.js'
import { kernelConfig, MIGRATIONS_ROOT, type Dialect } from '../kernel.js'
import { openRaw, writeRaw, type RawReader } from '../raw.js'

// The signed-in devices of a customer, on one dialect: each sign-in is a session its renewals carry, listed with its
// device, its sign-in time and its last activity, and ended as a whole by a sign-out, an end of that session or an end
// of every session. The clock is faked (Date only) at whole seconds and stands still, so a test moves it; refresh
// tokens live an hour here, so a session can expire inside a test. A race is forced as the rotation suite forces it:
// the first read of a token row lets a second store on the same database commit before it answers.

const PASSWORD = 'sessions-correct-horse'
const NEW_PASSWORD = 'sessions-new-horse-battery'
/** Cost 4: a sign-in compares against the customer's own hash, so the model's many sign-ins stay cheap. */
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4)
const WINDOW_MS = 30_000
const REFRESH_TTL_MS = 3_600_000
const UNKNOWN = 'Unknown device'

const FIREFOX_WINDOWS = {
  header: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  label: 'Firefox on Windows',
}
const SAFARI_IPHONE = {
  header:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  label: 'Safari on iPhone',
}
const CHROME_MACOS = {
  header:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  label: 'Chrome on macOS',
}
const EDGE_WINDOWS = {
  header:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  label: 'Edge on Windows',
}

export interface SessionsSuiteOptions {
  /** fast-check runs for the model property. */
  propertyRuns: number
}

export interface SessionsDatabase {
  /** The SQLite file, or the Postgres URL. */
  target: string
  drop(): Promise<void>
}

interface TokenRow {
  id: string
  customer_id: string
  token_hash: string
  revoked_at: string | null
  replaced_by_jti: string | null
  expires_at: string
  created_at: string
}

const COLUMNS = `id, customer_id, token_hash, CAST(revoked_at AS TEXT) AS revoked_at, replaced_by_jti,
  CAST(expires_at AS TEXT) AS expires_at, CAST(created_at AS TEXT) AS created_at`

/** `ok` when the promise resolves, else the AuthError's code. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (error) {
    return error instanceof AuthError ? error.code : `threw ${String(error)}`
  }
}

const jtiOf = (token: string): string => decodeJwt(token).jti as string
const sidOf = (token: string): unknown => decodeJwt(token)['sid']
/** An instant as milliseconds, whether the row carries a string or a Date; NaN for anything else. */
const instant = (value: unknown): number => new Date(value as string).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()

/** A whole second, so a token's `exp` (seconds) and its row's `expires_at` (milliseconds) agree. */
const wholeSecond = (ms: number): number => Math.floor(ms / 1000) * 1000

export function sessionsSuite(
  dialect: Dialect,
  start: () => Promise<SessionsDatabase>,
  opts: SessionsSuiteOptions,
): void {
  describe(`signed-in devices (${dialect})`, () => {
    let database: SessionsDatabase
    let raw: RawReader
    let main: Server
    let other: Server
    let sweeper: SweeperHandle

    type Server = ReturnType<typeof serverOver>
    type Tokens = Awaited<ReturnType<Server['auth']['refresh']>>

    function storeFor(target: string): CommandStore {
      return createCommandStore(
        kernelConfig(dialect),
        dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target },
      )
    }

    function authOver(store: CommandStore, repos: Repositories) {
      const logger = createLogger({ pretty: false, level: 'error' })
      const eventBus = new InProcessEventBus({ logger })
      const { publisher } = wirePublisher(
        { createEventPublisher, createRelay },
        { store, eventLog: repos.eventLog, eventBus, logger },
      )
      return createAuthService({
        repos,
        publisher,
        logger,
        jwtSecret: 'test-secret-32-characters-long-x',
        accessTtl: '15m',
        refreshTtl: '1h',
      })
    }

    function serverOver(store: CommandStore) {
      const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
      return { store, repos, auth: authOver(store, repos) }
    }

    /** `server`'s auth service, whose first read of a token row lets `competitor` commit before it answers. */
    function racingAfterRead(server: Server, competitor: () => Promise<void>) {
      const { refreshToken } = server.repos
      let raced = false
      return authOver(server.store, {
        ...server.repos,
        refreshToken: {
          ...refreshToken,
          async findById(tx, id) {
            const row = await refreshToken.findById(tx, id)
            if (row !== null && !raced) {
              raced = true
              await competitor()
            }
            return row
          },
        },
      })
    }

    const tick = (ms = 1_000): void => {
      vi.setSystemTime(Date.now() + ms)
    }

    const rowsOf = (customerId: string): Promise<TokenRow[]> =>
      raw.rows<TokenRow>(
        `SELECT ${COLUMNS} FROM refresh_tokens WHERE customer_id = ? ORDER BY id`,
        [customerId],
      )

    const liveOf = async (customerId: string): Promise<string[]> =>
      (await rowsOf(customerId)).filter((row) => row.revoked_at === null).map((row) => row.id)

    const rowOf = (jti: string) =>
      main.store.read((tx) => main.repos.refreshToken.findById(tx, jti))

    /** A customer with a password and no session yet: written as a seed would, so nothing signs in on its own. */
    async function customer(label: string, extra: { pending?: boolean } = {}) {
      const id = uuidv7()
      const email = `${label}-${id}@sessions.test`
      const now = new Date()
      await main.store.transaction((tx) =>
        main.repos.customer.insert(tx, {
          id,
          email,
          passwordHash: PASSWORD_HASH,
          ...(extra.pending === true && { emailVerification: 'pending' as const }),
          createdAt: now,
          updatedAt: now,
        }),
      )
      return { id, email }
    }

    const signIn = async (email: string, device: { header: string }) =>
      (await main.auth.login(email, PASSWORD, { userAgent: device.header })).tokens

    /** A customer signed in on two devices, Firefox on Windows and Safari on iPhone. */
    async function onTwoDevices() {
      const c = await customer('two-devices')
      const first = await signIn(c.email, FIREFOX_WINDOWS)
      tick()
      const second = await signIn(c.email, SAFARI_IPHONE)
      tick()
      return { ...c, first, second }
    }

    beforeAll(async () => {
      database = await start()
      main = serverOver(storeFor(database.target))
      await runMigrations(main.store, { migrationsRoot: MIGRATIONS_ROOT })
      other = serverOver(storeFor(database.target))
      raw = openRaw(dialect, database.target)
      sweeper = startRefreshTokenSweeper({
        store: main.store,
        refreshTokens: main.repos.refreshToken,
        logger: createLogger({ pretty: false, level: 'error' }),
        intervalMs: 3_600_000,
      })
    }, 60_000)

    afterAll(async () => {
      sweeper?.stop()
      await raw?.close()
      await other?.store.close()
      await main?.store.close()
      await database?.drop()
    }, 60_000)

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: wholeSecond(Date.now()) })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    describe('AC-1: every sign-in starts a session its renewals carry', () => {
      /** `at`: the instant the sign-in under test ran. */
      type Signed = {
        customerId: string
        email: string
        tokens: Tokens
        otherJti: string
        at: number
      }

      /** The customer's other session, started before the sign-in under test (a reset or change ends it). */
      const otherSession = async (email: string): Promise<string> => {
        const tokens = await signIn(email, SAFARI_IPHONE)
        tick()
        return jtiOf(tokens.refreshToken)
      }

      const entries: Array<{ entry: string; sign: (header: string) => Promise<Signed> }> = [
        {
          entry: 'login',
          sign: async (header) => {
            const c = await customer('login')
            const otherJti = await otherSession(c.email)
            const at = Date.now()
            const { tokens } = await main.auth.login(c.email, PASSWORD, { userAgent: header })
            return { customerId: c.id, email: c.email, tokens, otherJti, at }
          },
        },
        {
          entry: 'register (policy off)',
          sign: async (header) => {
            const email = `register-${uuidv7()}@sessions.test`
            const at = Date.now()
            const registered = await main.auth.register(
              { email, password: PASSWORD },
              { userAgent: header },
            )
            tick()
            const otherJti = await otherSession(email)
            return {
              customerId: registered.customer.id,
              email,
              tokens: registered.tokens,
              otherJti,
              at,
            }
          },
        },
        {
          entry: 'verifyEmail',
          sign: async (header) => {
            const c = await customer('verify', { pending: true })
            const otherJti = await otherSession(c.email)
            const token = `verify-${uuidv7()}`
            const now = new Date()
            await main.store.transaction((tx) =>
              main.repos.emailVerificationToken.insert(tx, {
                id: uuidv7(),
                customerId: c.id,
                tokenHash: hashResetToken(token),
                expiresAt: new Date(now.getTime() + 600_000),
                createdAt: now,
              }),
            )
            const at = Date.now()
            const { tokens } = await main.auth.verifyEmail(token, { userAgent: header })
            return { customerId: c.id, email: c.email, tokens, otherJti, at }
          },
        },
        {
          entry: 'resetPassword',
          sign: async (header) => {
            const c = await customer('reset')
            const otherJti = await otherSession(c.email)
            const token = `reset-${uuidv7()}`
            const now = new Date()
            await main.store.transaction((tx) =>
              main.repos.passwordResetToken.insert(tx, {
                id: uuidv7(),
                customerId: c.id,
                tokenHash: hashResetToken(token),
                expiresAt: new Date(now.getTime() + 600_000),
                createdAt: now,
              }),
            )
            const at = Date.now()
            const { tokens } = await main.auth.resetPassword(token, NEW_PASSWORD, {
              userAgent: header,
            })
            return { customerId: c.id, email: c.email, tokens, otherJti, at }
          },
        },
        {
          entry: 'changePassword',
          sign: async (header) => {
            const c = await customer('change')
            const otherJti = await otherSession(c.email)
            const at = Date.now()
            const { tokens } = await main.auth.changePassword(c.id, PASSWORD, NEW_PASSWORD, {
              userAgent: header,
            })
            return { customerId: c.id, email: c.email, tokens, otherJti, at }
          },
        },
      ]

      // Defect: two devices share a session (ending one ends both), a renewal starts a "new device" or moves its
      // sign-in time, or a token does not say which session it is, so the list cannot mark this device.
      it.each(entries)(
        'AC-1: $entry writes a row with a session of its own, signed in now, labelled from the user agent, named by both tokens; five renewals carry all three and the sid',
        async ({ sign }) => {
          const signed = await sign(FIREFOX_WINDOWS.header)
          const signedInAt = signed.at
          const row = await rowOf(jtiOf(signed.tokens.refreshToken))
          const session = row?.sessionId

          expect(row?.device).toBe(FIREFOX_WINDOWS.label)
          expect(instant(row?.sessionStartedAt)).toBe(signedInAt)
          expect(session).toEqual(expect.any(String))
          expect([sidOf(signed.tokens.accessToken), sidOf(signed.tokens.refreshToken)]).toEqual([
            session,
            session,
          ])
          expect((await rowOf(signed.otherJti))?.sessionId, 'the other session’s id').not.toBe(
            session,
          )

          const chain = [jtiOf(signed.tokens.refreshToken)]
          let tokens = signed.tokens
          for (let renewal = 1; renewal <= 5; renewal += 1) {
            tick()
            tokens = await main.auth.refresh(tokens.refreshToken)
            const successor = await rowOf(jtiOf(tokens.refreshToken))
            chain.push(jtiOf(tokens.refreshToken))
            expect(
              [
                successor?.sessionId,
                instant(successor?.sessionStartedAt),
                successor?.device,
                sidOf(tokens.accessToken),
                sidOf(tokens.refreshToken),
              ],
              `renewal ${renewal}`,
            ).toEqual([session, signedInAt, FIREFOX_WINDOWS.label, session, session])
          }

          // The chain and the other session are every row the customer has, and only the chain carries the session.
          const rows = await rowsOf(signed.customerId)
          expect(rows.map((r) => r.id).sort()).toEqual([...chain, signed.otherJti].sort())
          const sessions = await Promise.all(rows.map(async (r) => (await rowOf(r.id))?.sessionId))
          expect(sessions.filter((id: unknown) => id === session)).toHaveLength(chain.length)
        },
      )
    })

    describe('AC-3: the list of sessions', () => {
      // Defect: an expired session stays listed until the sweeper purges it, so a device long gone shows as signed in.
      it('AC-3: a session whose newest row is past its expiry and not yet purged is not listed; a live one beside it is', async () => {
        const c = await customer('expired')
        const stale = await signIn(c.email, FIREFOX_WINDOWS)
        tick(REFRESH_TTL_MS - 60_000)
        const fresh = await signIn(c.email, SAFARI_IPHONE)
        tick(120_000)

        const listed = await main.auth.listSessions(c.id)

        expect((await rowsOf(c.id)).map((r) => r.id)).toContain(jtiOf(stale.refreshToken))
        expect(listed.map((s: CustomerSession) => s.id)).toEqual([sidOf(fresh.refreshToken)])
      })

      // Defect: a row from before sessions existed is dropped from the list or read as another session's.
      it('AC-3: a row with no session columns lists as its own session, Unknown device, signed in and last active at its createdAt', async () => {
        const c = await customer('legacy-row')
        const id = uuidv7()
        const createdAt = iso(Date.now() - 60_000)
        await writeRaw(
          dialect,
          database.target,
          `INSERT INTO refresh_tokens (id, customer_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
          [id, c.id, uuidv7(), iso(Date.now() + REFRESH_TTL_MS), createdAt],
        )

        expect(await main.auth.listSessions(c.id, id)).toEqual([
          { id, device: UNKNOWN, signedInAt: createdAt, lastActiveAt: createdAt, current: true },
        ])
      })

      type Who = 'a' | 'b'
      type Op =
        | {
            kind: 'signIn' | 'renew' | 'renewTwice' | 'signOut' | 'endOne' | 'endForeign'
            device: number
          }
        | { kind: 'endAll'; who: Who }
        | { kind: 'purge' }
        | { kind: 'idle'; minutes: number }

      const onDevice = (
        kind: 'signIn' | 'renew' | 'renewTwice' | 'signOut' | 'endOne' | 'endForeign',
      ) => fc.record({ kind: fc.constant(kind), device: fc.nat({ max: 3 }) })

      const arbOp: fc.Arbitrary<Op> = fc.oneof(
        { arbitrary: onDevice('signIn'), weight: 3 },
        { arbitrary: onDevice('renew'), weight: 3 },
        onDevice('renewTwice'),
        onDevice('signOut'),
        onDevice('endOne'),
        onDevice('endForeign'),
        fc.record({ kind: fc.constant('endAll' as const), who: fc.constantFrom<Who>('a', 'b') }),
        fc.record({ kind: fc.constant('purge' as const) }),
        fc.record({ kind: fc.constant('idle' as const), minutes: fc.constantFrom(20, 45) }),
      )

      /** Three devices of customer a, one of customer b. */
      const DEVICES: Array<{ who: Who; header: string; label: string }> = [
        { who: 'a', ...FIREFOX_WINDOWS },
        { who: 'a', ...SAFARI_IPHONE },
        { who: 'a', ...CHROME_MACOS },
        { who: 'b', ...EDGE_WINDOWS },
      ]

      interface ModelSession {
        id: string
        who: Who
        device: string
        signedInAt: number
        lastActiveAt: number
        ended: boolean
      }

      // Defect: a signed-out or expired device stays listed, two tabs of one device show as two devices, the sign-in
      // time moves at a renewal or goes with the session's first row, the order is not by last activity, the wrong
      // row (or more than one) is marked as this device, or one customer sees another's.
      it('AC-3: property: over sign-ins, renewals, two renewals in the window, sign-outs, end-one, end-all, purges and idle time on three devices of one customer and one of another, listSessions equals the model', async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(arbOp, { minLength: 1, maxLength: 14 }), async (ops) => {
            const customers = { a: await customer('model-a'), b: await customer('model-b') }
            const sessions = new Map<string, ModelSession>()
            const held: Array<{ token: string | null; sid: string | null }> = DEVICES.map(() => ({
              token: null,
              sid: null,
            }))

            const unexpired = (s: ModelSession) => Date.now() < s.lastActiveAt + REFRESH_TTL_MS
            const listed = (who: Who, current?: string) =>
              [...sessions.values()]
                .filter((s) => s.who === who && !s.ended && unexpired(s))
                .sort((x, y) => y.lastActiveAt - x.lastActiveAt)
                .map((s) => ({
                  id: s.id,
                  device: s.device,
                  signedInAt: iso(s.signedInAt),
                  lastActiveAt: iso(s.lastActiveAt),
                  current: s.id === current,
                }))

            const step = async (op: Op, label: string): Promise<void> => {
              if (op.kind === 'purge') {
                await sweeper.tick()
                return
              }
              if (op.kind === 'idle') {
                tick(op.minutes * 60_000)
                return
              }
              if (op.kind === 'endAll') {
                await main.auth.endAllSessions(customers[op.who].id)
                for (const s of sessions.values()) if (s.who === op.who) s.ended = true
                return
              }
              const device = DEVICES[op.device]!
              const hold = held[op.device]!
              const owner = customers[device.who]
              if (op.kind === 'signIn') {
                const tokens = await signIn(owner.email, device)
                const sid = sidOf(tokens.refreshToken) as string
                hold.token = tokens.refreshToken
                hold.sid = sid
                const now = Date.now()
                sessions.set(sid, {
                  id: sid,
                  who: device.who,
                  device: device.label,
                  signedInAt: now,
                  lastActiveAt: now,
                  ended: false,
                })
                return
              }
              if (hold.token === null || hold.sid === null) return
              const session = sessions.get(hold.sid)!
              const renewable = !session.ended && unexpired(session)
              if (op.kind === 'renew' || op.kind === 'renewTwice') {
                const times = op.kind === 'renew' ? 1 : 2
                const answers: string[] = []
                let next: Tokens | undefined
                for (let i = 0; i < times; i += 1) {
                  answers.push(
                    await outcomeOf(
                      main.auth.refresh(hold.token).then((tokens) => {
                        next = tokens
                      }),
                    ),
                  )
                }
                expect(answers, label).toEqual(
                  answers.map(() => (renewable ? 'ok' : 'auth.token_invalid')),
                )
                if (renewable && next !== undefined) {
                  expect(sidOf(next.refreshToken), `${label}: the renewal's sid`).toBe(hold.sid)
                  hold.token = next.refreshToken
                  session.lastActiveAt = Date.now()
                }
                return
              }
              if (op.kind === 'signOut') {
                await main.auth.logout(hold.token)
                session.ended = true
                return
              }
              if (op.kind === 'endForeign') {
                const stranger = customers[device.who === 'a' ? 'b' : 'a']
                expect(await main.auth.endSession(stranger.id, hold.sid), label).toBe(false)
                return
              }
              const ended = await main.auth.endSession(owner.id, hold.sid)
              if (session.ended) expect(ended, label).toBe(false)
              if (renewable) expect(ended, label).toBe(true)
              session.ended = true
            }

            for (const [index, op] of ops.entries()) {
              tick()
              const label = `step ${index} of ${JSON.stringify(ops)}`
              await step(op, label)
              const inHand = held[index % 3]!.sid ?? undefined
              expect(await main.auth.listSessions(customers.a.id, inHand), label).toEqual(
                listed('a', inHand),
              )
              expect(await main.auth.listSessions(customers.a.id), `${label}: none passed`).toEqual(
                listed('a'),
              )
              const theirs = held[3]!.sid ?? undefined
              expect(await main.auth.listSessions(customers.b.id, theirs), `${label}: b`).toEqual(
                listed('b', theirs),
              )
            }
          }),
          { numRuns: opts.propertyRuns },
        )
      }, 240_000)
    })

    describe('AC-4: ending one session', () => {
      // Defect: the end revokes only the newest row, so a renewed parent still in the window renews again; or its
      // refusal is read as theft and ends the other session; or the end reaches past the session.
      it('AC-4: endSession answers true; that session’s live token and its renewed parent in the window are refused, that refusal ends nothing else, and the other session still refreshes', async () => {
        const { id, first, second } = await onTwoDevices()
        const renewed = await main.auth.refresh(first.refreshToken)
        tick()

        const ended = await main.auth.endSession(id, sidOf(first.refreshToken) as string)

        expect(ended).toBe(true)
        expect([
          await outcomeOf(main.auth.refresh(renewed.refreshToken)),
          await outcomeOf(main.auth.refresh(first.refreshToken)),
        ]).toEqual(['auth.token_invalid', 'auth.token_invalid'])
        expect(await outcomeOf(main.auth.refresh(second.refreshToken)), 'the other session').toBe(
          'ok',
        )
      })

      // Defect: a repeat or a wrong id reports success, or one customer ends another's session.
      it('AC-4: endSession answers false and changes no row for the same id again, an id no session has, and another customer’s session', async () => {
        const mine = await onTwoDevices()
        const theirs = await onTwoDevices()
        const session = sidOf(mine.first.refreshToken) as string
        expect(await main.auth.endSession(mine.id, session)).toBe(true)
        const before = { mine: await rowsOf(mine.id), theirs: await rowsOf(theirs.id) }
        tick()

        const answers = [
          await main.auth.endSession(mine.id, session),
          await main.auth.endSession(mine.id, uuidv7()),
          await main.auth.endSession(mine.id, sidOf(theirs.first.refreshToken) as string),
        ]

        expect(answers).toEqual([false, false, false])
        expect({ mine: await rowsOf(mine.id), theirs: await rowsOf(theirs.id) }).toEqual(before)
        expect(await outcomeOf(main.auth.refresh(theirs.first.refreshToken))).toBe('ok')
      })
    })

    describe('AC-5: ending a session while it renews', () => {
      // Defect: the renewal commits its successor after the end, so the removed device keeps a token for an hour (a
      // week by default).
      it('AC-5: endSession landing after refresh has read the row: the refresh is refused, no successor exists, and the other device still refreshes', async () => {
        const { id, first, second } = await onTwoDevices()
        const session = sidOf(first.refreshToken) as string
        let endedInRace: boolean | undefined
        const racing = racingAfterRead(main, async () => {
          endedInRace = await other.auth.endSession(id, session)
        })
        const rowsBefore = (await rowsOf(id)).length

        const answer = await outcomeOf(racing.refresh(first.refreshToken))

        expect(endedInRace, 'the end committed before the rotation').toBe(true)
        expect(answer).toBe('auth.token_invalid')
        expect((await rowsOf(id)).length, 'no successor row').toBe(rowsBefore)
        expect(await outcomeOf(main.auth.refresh(second.refreshToken)), 'the other device').toBe(
          'ok',
        )
      })

      // Defect: whichever commits second leaves a live row in the ended session.
      it.each([
        { order: 'end, then refresh' },
        { order: 'refresh, then end' },
        { order: 'both at once, on two servers' },
      ])(
        'AC-5: endSession and a refresh of that session, $order: no row of the session is live and no token of it refreshes',
        async ({ order }) => {
          const { id, first, second } = await onTwoDevices()
          const session = sidOf(first.refreshToken) as string
          const tokens = [first.refreshToken]
          const refresh = () =>
            main.auth.refresh(first.refreshToken).then(
              (next) => {
                tokens.push(next.refreshToken)
              },
              () => undefined,
            )
          const end = () => other.auth.endSession(id, session)

          if (order === 'end, then refresh') {
            await end()
            await refresh()
          } else if (order === 'refresh, then end') {
            await refresh()
            await end()
          } else {
            await Promise.all([refresh(), end()])
          }

          const live = await liveOf(id)
          expect(live.filter((jti) => tokens.map(jtiOf).includes(jti))).toEqual([])
          expect(live).toEqual([jtiOf(second.refreshToken)])
          expect(await Promise.all(tokens.map((t) => outcomeOf(main.auth.refresh(t))))).toEqual(
            tokens.map(() => 'auth.token_invalid'),
          )
        },
      )
    })

    describe('AC-6: sign-out ends the presented token’s session, and only it', () => {
      // Defect: a sign-out crossing a renewal signs out the shopper's other devices (the old rule ended every session).
      it('AC-6: a logout presenting a renewed token (R0 → R1) refuses R1, and the other device still refreshes', async () => {
        const { first, second } = await onTwoDevices()
        const r1 = await main.auth.refresh(first.refreshToken)
        tick()

        await main.auth.logout(first.refreshToken)

        expect([
          await outcomeOf(main.auth.refresh(r1.refreshToken)),
          await outcomeOf(main.auth.refresh(second.refreshToken)),
        ]).toEqual(['auth.token_invalid', 'ok'])
      })

      // Defect: the sign-out follows the one pointer and leaves the fork the pointer no longer names alive.
      it.each([{ presented: 'R0' }, { presented: 'R1' }])(
        'AC-6: with R0 renewed twice in the window (R1, R1′), a logout of $presented refuses both, and the other device still refreshes',
        async ({ presented }) => {
          const { first, second } = await onTwoDevices()
          const r1 = await main.auth.refresh(first.refreshToken)
          const r1Prime = await main.auth.refresh(first.refreshToken)
          tick()

          await main.auth.logout(presented === 'R0' ? first.refreshToken : r1.refreshToken)

          expect([
            await outcomeOf(main.auth.refresh(r1.refreshToken)),
            await outcomeOf(main.auth.refresh(r1Prime.refreshToken)),
            await outcomeOf(main.auth.refresh(second.refreshToken)),
          ]).toEqual(['auth.token_invalid', 'auth.token_invalid', 'ok'])
        },
      )

      // Defect: a sign-out of the successor leaves its parent able to renew inside the window (a fork of the session).
      it('AC-6: after logout(R1), R0 presented inside the window is refused, and the other device still refreshes', async () => {
        const { first, second } = await onTwoDevices()
        const r1 = await main.auth.refresh(first.refreshToken)
        tick()

        await main.auth.logout(r1.refreshToken)

        expect([
          await outcomeOf(main.auth.refresh(first.refreshToken)),
          await outcomeOf(main.auth.refresh(second.refreshToken)),
        ]).toEqual(['auth.token_invalid', 'ok'])
      })

      // Defect: a sign-out with a token whose row the sweeper purged does nothing (its session lives on) or ends every
      // session of the customer; or logout reads `sid` from any signed token, so an access token (whose jti has no
      // row) ends its session.
      it('AC-6: a logout presenting an access token ends nothing; one presenting a signed refresh token whose row is gone ends the session its sid names, and no other', async () => {
        const { id, first, second } = await onTwoDevices()
        const r1 = await main.auth.refresh(first.refreshToken)
        tick(WINDOW_MS + 1_000)
        await main.store.transaction((tx) =>
          main.repos.refreshToken.purgeRotated(tx, new Date(Date.now() - WINDOW_MS)),
        )
        expect((await rowsOf(id)).map((r) => r.id)).not.toContain(jtiOf(first.refreshToken))

        await main.auth.logout(r1.accessToken)
        let r2 = r1
        const afterAccess = await outcomeOf(
          main.auth.refresh(r1.refreshToken).then((tokens) => {
            r2 = tokens
          }),
        )
        expect(afterAccess, 'the session after a logout presenting its access token').toBe('ok')
        tick()
        await main.auth.logout(first.refreshToken)

        expect([
          await outcomeOf(main.auth.refresh(r2.refreshToken)),
          await outcomeOf(main.auth.refresh(second.refreshToken)),
        ]).toEqual(['auth.token_invalid', 'ok'])
      })

      // Defect: the write stays inside a try that swallows it, so a failed end answers success and the session lives.
      it('AC-6: a revokeSession that throws rejects logout (live and renewed tokens) and endSession; a session write that throws rejects endAllSessions', async () => {
        const { refreshToken } = main.repos
        const refused = async () => {
          throw new Error('write refused')
        }
        const failing = authOver(main.store, {
          ...main.repos,
          refreshToken: { ...refreshToken, revokeSession: refused, revokeAllForCustomer: refused },
        })
        const live = await onTwoDevices()
        const renewed = await onTwoDevices()
        await main.auth.refresh(renewed.first.refreshToken)

        await expect(failing.logout(live.first.refreshToken)).rejects.toThrow('write refused')
        await expect(failing.logout(renewed.first.refreshToken)).rejects.toThrow('write refused')
        await expect(
          failing.endSession(live.id, sidOf(live.second.refreshToken) as string),
        ).rejects.toThrow('write refused')
        await expect(failing.endAllSessions(live.id)).rejects.toThrow('write refused')
        expect(await outcomeOf(main.auth.refresh(live.first.refreshToken))).toBe('ok')
      })
    })

    describe('AC-7: ending every session', () => {
      // Defect: the end misses a device (a renewed fork, a third sign-in), or reaches another customer.
      it('AC-7: endAllSessions refuses every device’s refresh and empties the list; another customer still refreshes; a sign-in after it lists exactly one session', async () => {
        const c = await customer('end-all')
        const devices = [
          await signIn(c.email, FIREFOX_WINDOWS),
          await signIn(c.email, SAFARI_IPHONE),
          await signIn(c.email, CHROME_MACOS),
        ]
        const forked = await main.auth.refresh(devices[0]!.refreshToken)
        const bystander = await customer('end-all-bystander')
        const theirs = await signIn(bystander.email, EDGE_WINDOWS)
        tick()

        await main.auth.endAllSessions(c.id)

        const held = [forked.refreshToken, ...devices.map((t) => t.refreshToken)]
        expect(await Promise.all(held.map((t) => outcomeOf(main.auth.refresh(t))))).toEqual(
          held.map(() => 'auth.token_invalid'),
        )
        expect(await main.auth.listSessions(c.id)).toEqual([])
        expect(await outcomeOf(main.auth.refresh(theirs.refreshToken)), 'the other customer').toBe(
          'ok',
        )
        tick()
        const again = await signIn(c.email, CHROME_MACOS)
        expect(
          (await main.auth.listSessions(c.id)).map((s: CustomerSession) => [s.id, s.device]),
        ).toEqual([[sidOf(again.refreshToken), CHROME_MACOS.label]])
      })
    })
  })
}
