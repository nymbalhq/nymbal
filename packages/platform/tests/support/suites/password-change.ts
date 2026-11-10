import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import { decodeJwt } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { resolveAuthSecret } from '../../../src/auth-secret.js'
import { createCommandStore, type CommandStore } from '../../../src/db/command-store.js'
import { InMemoryDocumentStore } from '../../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../../src/event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../../../src/index.js'
import { createLogger } from '../../../src/logger.js'
import { buildRepositories, type Repositories } from '../../../src/repositories/index.js'
import { createAuthService } from '../../../src/services/auth-service.js'
import { wirePublisher } from '../../../src/tests/publisher.js'
import { kernelConfig, type Dialect } from '../kernel.js'
import {
  change,
  customerRowOf,
  delivered,
  forgot,
  jtiOf,
  liveRefreshOf,
  me,
  openPasswordStore,
  refresh,
  refreshRowsOf,
  registered,
  said,
  stateOf,
  type OpenStore,
  type PasswordStore,
  type Shopper,
} from '../password-reset.js'

// "Change password" on one dialect, over HTTP against a kernel built from `src/` (tests/support/password-reset.ts). A
// signed-in shopper who gives the current password gets a new session; every other session's refresh token, and the
// caller's old one, is refused from then on, and an access token already issued is dead within accessTtl. A refusal
// changes nothing and is never a 401, which the SDK would answer with a refresh. The race with a refresh in flight is
// forced at the point it opens: the refresh's first read of its row lets the change commit before it answers.

export interface PasswordChangeSuiteOptions {
  open: OpenStore
  propertyRuns: number
}

const SHORT = 'seven77'

/** `ok` when the promise resolves, else the AuthError's code. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (error) {
    return error instanceof AuthError ? error.code : `threw ${String(error)}`
  }
}

interface Session {
  accessToken: string
  refreshToken: string
  /** The refresh token this session rotated from, refused like the rest once the password changes. */
  rotatedFrom?: string
}

export function passwordChangeSuite(dialect: Dialect, options: PasswordChangeSuiteOptions): void {
  describe(`password change (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openPasswordStore(options.open)
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    /** The customer's sessions: the registration's and n - 1 sign-ins, those marked rotated once each. */
    async function sessionsOf(owner: Shopper, rotated: boolean[]): Promise<Session[]> {
      const sessions: Session[] = []
      for (const [i, rotate] of rotated.entries()) {
        const first =
          i === 0
            ? { accessToken: owner.accessToken, refreshToken: owner.refreshToken }
            : (await s.k.services.auth.login(owner.email, owner.password)).tokens
        if (!rotate) {
          sessions.push({ accessToken: first.accessToken, refreshToken: first.refreshToken })
          continue
        }
        const next = await s.k.services.auth.refresh(first.refreshToken)
        sessions.push({
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          rotatedFrom: first.refreshToken,
        })
      }
      return sessions
    }

    describe('AC-18: a changed password ends every other session and renews the caller’s', () => {
      // Defect: a family is left live, or A's own session dies, or the new token is issued inside the revoking
      // transaction and revoked with it.
      it('AC-18: property: over n sessions from 1 to 5, some rotated, a change from session A answers 200 with a new access token and refresh cookie; every earlier refresh token, A’s included, is refused, and A’s new one refreshes', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
            fc.nat(),
            async (rotated, pick) => {
              const owner = await registered(s, 'ac18')
              const sessions = await sessionsOf(owner, rotated)
              const a = sessions[pick % sessions.length]!
              const next = `ac18-${randomUUID()}`

              const answer = await change(s, a.accessToken, owner.password, next)

              expect(answer.status, answer.text).toBe(200)
              const renewed = answer.body.data?.accessToken
              expect(renewed).not.toBe(a.accessToken)
              const account = await me(s, renewed!)
              expect([
                account.status,
                (account.body.data as { id?: string } | undefined)?.id,
              ]).toEqual([200, owner.customerId])
              const earlier = sessions.flatMap((x) =>
                x.rotatedFrom === undefined ? [x.refreshToken] : [x.refreshToken, x.rotatedFrom],
              )
              const refused = []
              for (const token of earlier) refused.push((await refresh(s, token)).status)
              expect(refused).toEqual(earlier.map(() => 401))
              expect((await refresh(s, answer.refreshCookie!)).status).toBe(200)
            },
          ),
          {
            numRuns: options.propertyRuns,
            examples: [
              [[true, false, true], 1],
              [[false], 0],
            ],
          },
        )
      }, 180_000)
    })

    describe('AC-19: a refused change changes nothing and is no 401', () => {
      // Defect: the refusal is 401, so the SDK refreshes and resends; or a refused change still revokes.
      it('AC-19: a wrong current password answers 400 auth.current_password_invalid and a new password under 8 answers 400 validation.failed; after each the hash, the sessions and the reset rows are as they were, and neither password is in a log line', async () => {
        const owner = await registered(s, 'ac19')
        await s.k.services.auth.login(owner.email, owner.password)
        await forgot(s, owner.email)
        await delivered(s)
        const wrong = `ac19-wrong-${randomUUID()}`
        const short = SHORT
        const before = await stateOf(s, owner.customerId)
        const logsBefore = s.logs.length

        const wrongCurrent = await change(s, owner.accessToken, wrong, `ac19-next-${randomUUID()}`)
        const afterWrong = await stateOf(s, owner.customerId)
        const tooShort = await change(s, owner.accessToken, owner.password, short)
        const afterShort = await stateOf(s, owner.customerId)

        expect(said(wrongCurrent)).toEqual([400, 'auth.current_password_invalid'])
        expect(said(tooShort)).toEqual([400, 'validation.failed'])
        expect(before.resets).toHaveLength(1)
        expect(afterWrong).toEqual(before)
        expect(afterShort).toEqual(before)
        expect(
          s.logs.slice(logsBefore).filter((line) => line.includes(wrong) || line.includes(short)),
        ).toEqual([])
      })
    })

    describe('AC-20: a refresh in flight loses to a changed password', () => {
      // Defect: the revoke runs without the locked sweep, leaving a live token after a changed password.
      it('AC-20: a refresh that has read its token, then a change that commits, then the refresh’s rotate: the refresh is refused and no successor row exists; the change’s session is the only live one', async () => {
        const owner = await registered(s, 'ac20')
        // The refresh runs on a second store; the change on the kernel's own, a connection the read does not hold.
        const main = serverOver(createStoreFor(s))
        try {
          let changed: { refreshToken: string } | undefined
          let changeOutcome = 'not run'
          const racing = racingAfterRead(main, async () => {
            try {
              changed = (
                await s.k.services.auth.changePassword(
                  owner.customerId,
                  owner.password,
                  `ac20-${randomUUID()}`,
                )
              ).tokens
              changeOutcome = 'ok'
            } catch (error) {
              changeOutcome = error instanceof AuthError ? error.code : `threw ${String(error)}`
            }
          })
          const rowsBefore = (await refreshRowsOf(s, owner.customerId)).length

          const answer = await outcomeOf(racing.refresh(owner.refreshToken))

          expect(changeOutcome).toBe('ok')
          expect(answer).toBe('auth.token_invalid')
          expect(
            (await refreshRowsOf(s, owner.customerId)).length,
            'the change’s session alone',
          ).toBe(rowsBefore + 1)
          expect(await liveRefreshOf(s, owner.customerId)).toEqual([jtiOf(changed!.refreshToken)])
        } finally {
          await main.store.close()
        }
      })
    })

    describe('AC-21: only the signed-in customer changes only their own password', () => {
      // Defect: the route is open or cross-account.
      it('AC-21: with no token the change answers 401 and changes nothing; X’s token changes X’s password and leaves Y’s hash and sessions as they were', async () => {
        const x = await registered(s, 'ac21-x')
        const y = await registered(s, 'ac21-y')
        const before = { x: await stateOf(s, x.customerId), y: await stateOf(s, y.customerId) }
        const next = `ac21-${randomUUID()}`

        const anonymous = await change(s, undefined, x.password, next)
        const afterAnonymous = {
          x: await stateOf(s, x.customerId),
          y: await stateOf(s, y.customerId),
        }
        const own = await change(s, x.accessToken, x.password, next)

        expect(anonymous.status).toBe(401)
        expect(afterAnonymous).toEqual(before)
        expect(own.status, own.text).toBe(200)
        expect(
          await bcrypt.compare(next, (await customerRowOf(s, x.customerId)).password_hash),
        ).toBe(true)
        expect(await stateOf(s, y.customerId)).toEqual(before.y)
        expect((await refresh(s, y.refreshToken)).status).toBe(200)
      })
    })

    // A second auth service over a store of its own on the kernel's database: a second server.
    function createStoreFor(store: PasswordStore): CommandStore {
      return createCommandStore(
        kernelConfig(dialect),
        dialect === 'sqlite' ? { sqlitePath: store.k.target } : { postgresUrl: store.k.target },
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
        jwtSecret: resolveAuthSecret(s.k.config, process.env).secret,
        accessTtl: '15m',
        refreshTtl: '7d',
      })
    }

    function serverOver(store: CommandStore) {
      const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
      return { store, repos, auth: authOver(store, repos) }
    }

    /** `server`'s auth service, whose first read of a token row lets `competitor` commit before it answers. */
    function racingAfterRead(
      server: ReturnType<typeof serverOver>,
      competitor: () => Promise<void>,
    ) {
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
  })

  describe(`password change and the access tokens already issued (${dialect})`, () => {
    let s: PasswordStore
    /** Short enough to outlive in a test; set past the schema's floor, after it has parsed. */
    const ACCESS_TTL_MS = 3_000

    beforeAll(async () => {
      s = await openPasswordStore(options.open, { accessTtl: `${ACCESS_TTL_MS / 1000}s` })
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    // Defect: the proof's wording "every access token is dead within accessTtl" is not what the code does, or a refresh
    // token issued before the change still mints one.
    it('AC-21: an access token issued before a change still reads the account until its expiry and is refused after it, within accessTtl of the change; no refresh token issued before the change mints one', async () => {
      const owner = await registered(s, 'ac21-ttl')
      const signedIn = await s.k.services.auth.login(owner.email, owner.password)
      const issued = signedIn.tokens.accessToken
      const expiresAtMs = (decodeJwt(issued).exp as number) * 1000

      const answer = await change(s, owner.accessToken, owner.password, `ac21-ttl-${randomUUID()}`)
      const changedAt = Date.now()
      const stillReads = await me(s, issued)
      const earlier = [
        await refresh(s, owner.refreshToken),
        await refresh(s, signedIn.tokens.refreshToken),
      ]
      let refusedAt = 0
      await vi.waitFor(
        async () => {
          expect((await me(s, issued)).status).toBe(401)
          refusedAt = Date.now()
        },
        { timeout: ACCESS_TTL_MS + 5_000, interval: 100 },
      )

      expect(answer.status, answer.text).toBe(200)
      expect(stillReads.status).toBe(200)
      expect(earlier.map((a) => a.status)).toEqual([401, 401])
      expect(refusedAt).toBeGreaterThanOrEqual(expiresAtMs)
      // The claim is whole seconds, so the token may outlive accessTtl by under one.
      expect(refusedAt - changedAt).toBeLessThanOrEqual(ACCESS_TTL_MS + 1_000 + 100)
    }, 30_000)
  })
}
