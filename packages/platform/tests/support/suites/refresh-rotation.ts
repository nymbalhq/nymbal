import fc from 'fast-check'
import { decodeJwt } from 'jose'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { createCommandStore, type CommandStore, type Tx } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../../src/event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../../../src/index.js'
import { createLogger } from '../../../src/logger.js'
import { buildRepositories, type Repositories } from '../../../src/repositories/index.js'
import type { RefreshTokenInsert } from '../../../src/repositories/refresh-token.js'
import { createAuthService } from '../../../src/services/auth-service.js'
import { wirePublisher } from '../../../src/tests/publisher.js'
import { kernelConfig, MIGRATIONS_ROOT, type Dialect } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'

// Refresh rotation against the writes that can cross it, on one dialect. A race is forced at the point it opens: the
// first read of the token row is wrapped so the competing write commits once that read has its answer. The competitor
// is a second store on the same database (a second server), because SQLite's one connection is held by the read in
// progress and a transaction may not open inside a read on Postgres or SQLite. The clock is faked (Date only) and
// stands still, so the 30 s window is crossed only when a test moves it.

const PASSWORD = 'rotation-correct-horse'
const WINDOW_MS = 30_000
const DAY_MS = 86_400_000

export interface RefreshRotationSuiteOptions {
  /** fast-check runs for the model property. */
  propertyRuns: number
}

export interface RefreshRotationDatabase {
  /** The SQLite file, or the Postgres URL. */
  target: string
  drop(): Promise<void>
}

/** A refresh_tokens row as a second connection reads it: every column as the database's text, for byte comparison. */
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

type RowState = 'live' | 'rotated' | 'ended' | 'malformed'

function stateOf(row: TokenRow): RowState {
  if (row.revoked_at === null) return row.replaced_by_jti === null ? 'live' : 'malformed'
  return row.replaced_by_jti === null ? 'ended' : 'rotated'
}

function tokenOf(customerId: string): RefreshTokenInsert {
  const createdAt = new Date()
  return {
    id: uuidv7(),
    customerId,
    tokenHash: uuidv7(),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + DAY_MS),
  }
}

/** `ok` when the promise resolves, else the AuthError's code. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (error) {
    return error instanceof AuthError ? error.code : `threw ${String(error)}`
  }
}

function jtiOf(token: string): string {
  return decodeJwt(token).jti as string
}

type ModelOp =
  | { kind: 'rotate'; target: number }
  | { kind: 'revoke'; target: number }
  | { kind: 'rotateAbsent' }
  | { kind: 'revokeAbsent' }
  | { kind: 'revokeAll' }

const arbOp: fc.Arbitrary<ModelOp> = fc.oneof(
  fc.record({ kind: fc.constant('rotate' as const), target: fc.nat() }),
  fc.record({ kind: fc.constant('revoke' as const), target: fc.nat() }),
  fc.record({ kind: fc.constant('rotateAbsent' as const) }),
  fc.record({ kind: fc.constant('revokeAbsent' as const) }),
  fc.record({ kind: fc.constant('revokeAll' as const) }),
)

export function refreshRotationSuite(
  dialect: Dialect,
  start: () => Promise<RefreshRotationDatabase>,
  opts: RefreshRotationSuiteOptions,
): void {
  describe(`refresh rotation against sign-out and revoke-all (${dialect})`, () => {
    let database: RefreshRotationDatabase
    let raw: RawReader
    let main: Server
    let other: Server

    type Server = ReturnType<typeof serverOver>

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
        refreshTtl: '7d',
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

    const transact = <T>(fn: (tx: Tx, repos: Repositories) => Promise<T>): Promise<T> =>
      main.store.transaction((tx) => fn(tx, main.repos))

    const insert = (...tokens: RefreshTokenInsert[]): Promise<void> =>
      transact(async (tx, repos) => {
        for (const token of tokens) await repos.refreshToken.insert(tx, token)
      })

    const rotate = (oldJti: string, next: RefreshTokenInsert) =>
      transact((tx, repos) => repos.refreshToken.rotate(tx, oldJti, next))

    const revoke = (id: string) => transact((tx, repos) => repos.refreshToken.revoke(tx, id))

    const revokeAll = (customerId: string) =>
      transact((tx, repos) => repos.refreshToken.revokeAllForCustomer(tx, customerId))

    const rowsOf = (customerId: string): Promise<TokenRow[]> =>
      raw.rows<TokenRow>(
        `SELECT ${COLUMNS} FROM refresh_tokens WHERE customer_id = ? ORDER BY id`,
        [customerId],
      )

    const rowOf = (id: string): Promise<TokenRow> =>
      raw.one<TokenRow>(`SELECT ${COLUMNS} FROM refresh_tokens WHERE id = ?`, [id])

    const liveOf = async (customerId: string): Promise<string[]> =>
      (await rowsOf(customerId)).filter((row) => row.revoked_at === null).map((row) => row.id)

    /** A customer signed in on two devices: `first` from registering, `second` from a login of its own. */
    async function customerOnTwoDevices() {
      const email = `rotation-${uuidv7()}@test.com`
      const registered = await main.auth.register({ email, password: PASSWORD })
      const second = await main.auth.login(email, PASSWORD)
      return {
        email,
        customerId: registered.customer.id,
        first: registered.tokens.refreshToken,
        second: second.tokens.refreshToken,
      }
    }

    beforeAll(async () => {
      database = await start()
      main = serverOver(storeFor(database.target))
      await runMigrations(main.store, { migrationsRoot: MIGRATIONS_ROOT })
      other = serverOver(storeFor(database.target))
      raw = openRaw(dialect, database.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await other?.store.close()
      await main?.store.close()
      await database?.drop()
    }, 60_000)

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    describe('AC-1: rotate and revoke by the state of the row', () => {
      // Defect: rotate returns nothing, or inserts no successor.
      it('AC-1: rotating a live row returns true, ends it with the successor recorded and adds a live successor', async () => {
        const customerId = uuidv7()
        const old = tokenOf(customerId)
        const next = tokenOf(customerId)
        await insert(old)

        const returned = await rotate(old.id, next)

        expect(returned).toBe(true)
        const rotated = await rowOf(old.id)
        expect(stateOf(rotated)).toBe('rotated')
        expect(rotated.replaced_by_jti).toBe(next.id)
        expect(await liveOf(customerId)).toEqual([next.id])
      })

      // Defect: the predicate is `revoked_at IS NULL` alone (two tabs lose a session), or re-rotation restarts the
      // window by writing a new revoked_at.
      it('AC-1: rotating a rotated row returns true, keeps its first revokedAt, moves the pointer and leaves both successors live', async () => {
        const customerId = uuidv7()
        const old = tokenOf(customerId)
        const first = tokenOf(customerId)
        const second = tokenOf(customerId)
        await insert(old)
        await rotate(old.id, first)
        const firstRotation = await rowOf(old.id)
        vi.setSystemTime(Date.now() + 5_000)

        const returned = await rotate(old.id, second)

        expect(returned).toBe(true)
        const after = await rowOf(old.id)
        expect(after.revoked_at, 'the first rotation’s instant stays').toBe(
          firstRotation.revoked_at,
        )
        expect(after.replaced_by_jti).toBe(second.id)
        expect((await liveOf(customerId)).sort()).toEqual([first.id, second.id].sort())
      })

      // Defect: rotate writes whatever the row's state, so a signed-out or swept token comes back to life.
      it.each([
        {
          label: 'revoked by revoke',
          arrange: async (id: string) => {
            await revoke(id)
          },
        },
        {
          label: 'rotated then swept by revoke-all',
          arrange: async (id: string, customerId: string) => {
            await rotate(id, tokenOf(customerId))
            const firstRotation = await rowOf(id)
            vi.setSystemTime(Date.now() + 5_000)
            await revokeAll(customerId)
            expect((await rowOf(id)).revoked_at, 'the first rotation’s instant stays').toBe(
              firstRotation.revoked_at,
            )
          },
        },
        {
          label: 'live then swept by revoke-all',
          arrange: async (_id: string, customerId: string) => {
            await revokeAll(customerId)
          },
        },
      ])(
        'AC-1: rotating a row $label returns false, leaves every row byte for byte and adds none',
        async ({ arrange }) => {
          const customerId = uuidv7()
          const old = tokenOf(customerId)
          await insert(old)
          await arrange(old.id, customerId)
          const before = await rowsOf(customerId)
          vi.setSystemTime(Date.now() + 5_000)

          const returned = await rotate(old.id, tokenOf(customerId))

          expect(returned).toBe(false)
          expect(await rowsOf(customerId)).toEqual(before)
        },
      )

      // Defect: the successor is inserted with no parent to update.
      it('AC-1: rotating an absent row returns false and adds no row', async () => {
        const customerId = uuidv7()
        const successor = tokenOf(customerId)

        const returned = await rotate(uuidv7(), successor)

        expect(returned).toBe(false)
        expect(await rowsOf(customerId)).toEqual([])
      })

      // Defect: revoke reports what it was asked rather than whether it ended a live row, so logout cannot tell a
      // rotated token from a live one.
      it('AC-1: revoke returns true for a live row only: false for one already revoked, one rotated and one absent, each left as it was', async () => {
        const customerId = uuidv7()
        const live = tokenOf(customerId)
        const rotated = tokenOf(customerId)
        await insert(live, rotated)
        await rotate(rotated.id, tokenOf(customerId))

        const onLive = await revoke(live.id)
        const revokedRow = await rowOf(live.id)
        const rotatedRow = await rowOf(rotated.id)
        vi.setSystemTime(Date.now() + 5_000)
        const onRevoked = await revoke(live.id)
        const onRotated = await revoke(rotated.id)
        const onAbsent = await revoke(uuidv7())

        expect([onLive, onRevoked, onRotated, onAbsent]).toEqual([true, false, false, false])
        expect(stateOf(revokedRow)).toBe('ended')
        expect(await rowOf(live.id)).toEqual(revokedRow)
        expect(await rowOf(rotated.id)).toEqual(rotatedRow)
      })
    })

    describe('AC-2: any order of rotate, revoke and revoke-all', () => {
      // Defect: any order of the three resurrects a row, leaves a successor the model does not have, or lets an ended
      // row rotate again; the sweep reaches another customer.
      it('AC-2: property: after every step the rows match the model, no ended row rotates and no swept row is live again', async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(arbOp, { minLength: 1, maxLength: 12 }), async (ops) => {
            const customerId = uuidv7()
            const bystander = tokenOf(uuidv7())
            const seeded = [tokenOf(customerId), tokenOf(customerId)]
            await insert(bystander, ...seeded)
            const bystanderBefore = await rowOf(bystander.id)

            const model = new Map<string, RowState>(seeded.map((token) => [token.id, 'live']))

            /** Applies `op` to the store and the model; returns what the store's call should have returned. */
            const step = async (op: ModelOp): Promise<[unknown, unknown]> => {
              const ids = [...model.keys()]
              if (op.kind === 'revokeAll') {
                await revokeAll(customerId)
                for (const id of ids) model.set(id, 'ended')
                return [undefined, undefined]
              }
              if (op.kind === 'rotateAbsent') {
                return [await rotate(uuidv7(), tokenOf(customerId)), false]
              }
              if (op.kind === 'revokeAbsent') return [await revoke(uuidv7()), false]
              const id = ids[op.target % ids.length]!
              if (op.kind === 'revoke') {
                const wasLive = model.get(id) === 'live'
                if (wasLive) model.set(id, 'ended')
                return [await revoke(id), wasLive]
              }
              const next = tokenOf(customerId)
              const rotatable = model.get(id) !== 'ended'
              if (rotatable) {
                model.set(id, 'rotated')
                model.set(next.id, 'live')
              }
              return [await rotate(id, next), rotatable]
            }

            const states = async () =>
              Object.fromEntries((await rowsOf(customerId)).map((row) => [row.id, stateOf(row)]))

            for (const [index, op] of ops.entries()) {
              const [returned, expected] = await step(op)
              const label = `step ${index} of ${JSON.stringify(ops)}`
              expect(returned, label).toBe(expected)
              expect(await states(), label).toEqual(Object.fromEntries(model))

              for (const [id, state] of model) {
                if (state !== 'ended') continue
                expect(await rotate(id, tokenOf(customerId)), `${label}: ${id} is ended`).toBe(
                  false,
                )
              }
              expect(await states(), `${label}: a refused rotate changes nothing`).toEqual(
                Object.fromEntries(model),
              )
            }
            expect(await rowOf(bystander.id)).toEqual(bystanderBefore)
          }),
          { numRuns: opts.propertyRuns },
        )
      }, 120_000)
    })

    describe('AC-3: a logout that lands after refresh has read the row', () => {
      // Defect: rotate ignores the logout that committed after the read, so a live token survives it, the loser's
      // refusal ends other sessions, or the logged-out row reads as rotated.
      it('AC-3: the refresh is refused, no successor exists, the logged-out row is untouched, the other device refreshes, and the same token presented again adds nothing', async () => {
        const { customerId, first, second } = await customerOnTwoDevices()
        const jti = jtiOf(first)
        let atLogout: TokenRow | undefined
        const racing = racingAfterRead(main, async () => {
          await other.auth.logout(first)
          atLogout = await rowOf(jti)
        })
        const rowsBefore = (await rowsOf(customerId)).length

        const answer = await outcomeOf(racing.refresh(first))

        expect(stateOf(atLogout!), 'the logout committed before the rotation').toBe('ended')
        expect(answer).toBe('auth.token_invalid')
        expect((await rowsOf(customerId)).length, 'no successor row').toBe(rowsBefore)
        const after = await rowOf(jti)
        expect(after.replaced_by_jti).toBeNull()
        expect(after.revoked_at, 'the logout’s instant').toBe(atLogout!.revoked_at)

        expect(await outcomeOf(main.auth.refresh(second)), 'the other device').toBe('ok')
        const rowsAfterOtherDevice = (await rowsOf(customerId)).length
        expect(await outcomeOf(main.auth.refresh(first)), 'presented again').toBe(
          'auth.token_invalid',
        )
        expect((await rowsOf(customerId)).length, 'presented again adds nothing').toBe(
          rowsAfterOtherDevice,
        )
      })
    })

    describe('AC-4: a revoke-all that lands after refresh has read the row', () => {
      // Defect: a rotation committing after reuse detection leaves a successor live when every session was ended.
      it('AC-4: replaying another rotated token at that point refuses the refresh, creates no successor and leaves the customer no live row', async () => {
        const { customerId, first, second } = await customerOnTwoDevices()
        await main.auth.refresh(first)
        vi.setSystemTime(Date.now() + WINDOW_MS + 1_000)
        let replay: string | undefined
        const racing = racingAfterRead(main, async () => {
          replay = await outcomeOf(other.auth.refresh(first))
        })
        const rowsBefore = (await rowsOf(customerId)).length

        const answer = await outcomeOf(racing.refresh(second))

        expect(replay, 'the replay past the window').toBe('auth.token_invalid')
        expect(answer).toBe('auth.token_invalid')
        expect((await rowsOf(customerId)).length, 'no successor row').toBe(rowsBefore)
        expect(await liveOf(customerId)).toEqual([])
      })
    })

    describe('AC-5: logout whatever the state of the token', () => {
      // Defect: the branch for a rotated token fires on a live or logged-out row and ends other devices; or the
      // logout of a rotated token matches no row and the successor stays live.
      it('AC-5: a logout of a live or already logged-out token ends only that token, and a logout of a rotated token (R0 → R1) refuses R1 and leaves no live row', async () => {
        const devices = await customerOnTwoDevices()
        await main.auth.logout(devices.first)
        const afterLive = await main.auth.refresh(devices.second)
        expect(
          await liveOf(devices.customerId),
          'only the other device’s successor is live after a logout of a live token',
        ).toEqual([jtiOf(afterLive.refreshToken)])
        await main.auth.logout(devices.first)
        const afterLoggedOut = await outcomeOf(main.auth.refresh(afterLive.refreshToken))
        expect(afterLoggedOut, 'the other device after a repeated logout').toBe('ok')

        const { customerId, first } = await customerOnTwoDevices()
        const r1 = await main.auth.refresh(first)

        await main.auth.logout(first)

        expect(await outcomeOf(main.auth.refresh(r1.refreshToken)), 'R1 after the logout').toBe(
          'auth.token_invalid',
        )
        expect(await liveOf(customerId)).toEqual([])
      })

      // Defect: the logout walks replaced_by_jti and misses the fork the pointer no longer names.
      it('AC-5: with R0 re-rotated inside the window (R1 and R1′), a logout of R0 refuses both and leaves no live row', async () => {
        const { customerId, first } = await customerOnTwoDevices()
        const r1 = await main.auth.refresh(first)
        const r1Prime = await main.auth.refresh(first)

        await main.auth.logout(first)

        expect([
          await outcomeOf(main.auth.refresh(r1.refreshToken)),
          await outcomeOf(main.auth.refresh(r1Prime.refreshToken)),
        ]).toEqual(['auth.token_invalid', 'auth.token_invalid'])
        expect(await liveOf(customerId)).toEqual([])
      })

      // Defect: the write stays inside the try that swallows an invalid token, so a failed revoke answers 200 and the
      // shopper's session survives a sign-out reported as done.
      it('AC-5: a repository write that throws during logout rejects the logout rather than resolving', async () => {
        const { refreshToken } = main.repos
        const failing = (write: 'revoke' | 'revokeAllForCustomer') =>
          authOver(main.store, {
            ...main.repos,
            refreshToken: {
              ...refreshToken,
              [write]: async () => {
                throw new Error(`${write} refused`)
              },
            },
          })
        const { first } = await customerOnTwoDevices()
        const rotated = await customerOnTwoDevices()
        await main.auth.refresh(rotated.first)

        await expect(failing('revoke').logout(first)).rejects.toThrow('revoke refused')
        await expect(failing('revokeAllForCustomer').logout(rotated.first)).rejects.toThrow(
          'revokeAllForCustomer refused',
        )
      })
    })

    describe('AC-6: a token rotated, then swept, then presented inside the window', () => {
      // Defect: revoke-all leaves the rotated row re-rotatable (a new live token after every session was ended), or
      // presenting it triggers another revoke-all and ends the login made since.
      it('AC-6: it is refused, adds no row, and a login made after the revoke-all still refreshes', async () => {
        const { customerId, email, first } = await customerOnTwoDevices()
        await main.auth.refresh(first)
        await revokeAll(customerId)
        const login = await main.auth.login(email, PASSWORD)
        const rowsBefore = (await rowsOf(customerId)).length

        const answer = await outcomeOf(main.auth.refresh(first))

        expect(answer).toBe('auth.token_invalid')
        expect((await rowsOf(customerId)).length, 'no row added').toBe(rowsBefore)
        expect(await outcomeOf(main.auth.refresh(login.tokens.refreshToken))).toBe('ok')
      })
    })
  })
}
