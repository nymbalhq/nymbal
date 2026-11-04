import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import fc from 'fast-check'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore, sqliteDb } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from './auth-service.js'
import { createLogger } from '../logger.js'

// A refresh token the service signed and that has not expired always had a row: every token is inserted before it is
// returned. Its row gone (purged once rotated past its window, or deleted) means it is being replayed, so presenting it
// ends every session of its customer, as presenting it with its row would have. A token that fails the signature or
// expiry check revokes nothing, whatever its jti. The clock is faked (Date only); the store and hashing run for real.

const WINDOW_MS = 30_000
const DAY_MS = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-06-01T09:00:00.000Z')
const PASSWORD = 'password123'
const SECRET = 'test-secret-32-characters-long-x'

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
    jwtSecret: SECRET,
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

/** The jti a refresh token carries, read from its payload without verifying it. */
function jtiOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
    jti: string
  }
  return payload.jti
}

/** A refresh JWT shaped as the service mints one, with a jti no row has. */
function refreshJwt(
  customer: { id: string; email: string },
  opts: { secret: string; issuedAt: number; expiresAt: number },
): Promise<string> {
  const jti = randomUUID()
  return new SignJWT({
    sub: customer.id,
    email: customer.email,
    roles: ['customer'],
    type: 'refresh',
    jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(opts.issuedAt / 1000))
    .setJti(jti)
    .setIssuer('nymbal')
    .setExpirationTime(Math.floor(opts.expiresAt / 1000))
    .sign(new TextEncoder().encode(opts.secret))
}

/** A customer signed in on two devices, `first` from registering and `second` from a login of its own. */
async function customerOnTwoDevices(auth: Setup['auth']) {
  const email = `unknown-jti-${randomUUID()}@test.com`
  const { customer, tokens } = await auth.register({ email, password: PASSWORD })
  const second = await auth.login(email, PASSWORD)
  return { customer, first: tokens.refreshToken, second: second.tokens.refreshToken }
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

describe('AC-2: a signed, unexpired refresh token whose row is gone is a replay', () => {
  it('AC-2: property: over chains R0 → … → Rk and any Ri whose row is gone, presenting Ri is refused and then every session of its customer is refused while another customer still refreshes; before that, an unknown jti signed with another secret or already expired is refused and the customer’s other device still refreshes', async () => {
    let start = T0
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 0, max: 4 })
          .chain((k) => fc.tuple(fc.constant(k), fc.integer({ min: 0, max: k }))),
        fc.integer({ min: 0, max: 6 * DAY_MS }),
        async ([k, i], presentedAfter) => {
          start += 8 * DAY_MS
          vi.setSystemTime(start)
          const { customer, first, second } = await customerOnTwoDevices(s.auth)
          const bystander = await customerOnTwoDevices(s.auth)
          const chain = [first]
          for (let j = 1; j <= k; j++) {
            vi.setSystemTime(start + j * 2 * WINDOW_MS)
            chain.push((await s.auth.refresh(chain[j - 1]!)).refreshToken)
          }
          const lost = chain[i]!
          await s.commandStore.transaction(async (tx) => {
            const t = sqliteSchema.refreshTokens
            sqliteDb(tx)
              .delete(t)
              .where(eq(t.id, jtiOf(lost)))
              .run()
          })

          const now = start + k * 2 * WINDOW_MS + presentedAfter
          vi.setSystemTime(now)
          const forged = await outcomeOf(
            s.auth.refresh(
              await refreshJwt(customer, {
                secret: 'another-secret-32-characters-lng',
                issuedAt: now,
                expiresAt: now + DAY_MS,
              }),
            ),
          )
          const expired = await outcomeOf(
            s.auth.refresh(
              await refreshJwt(customer, {
                secret: SECRET,
                issuedAt: now - 8 * DAY_MS,
                expiresAt: now - 1000,
              }),
            ),
          )
          const otherDevice = await s.auth.refresh(second).then(
            (tokens) => tokens.refreshToken,
            (error: unknown) => `refused: ${String(error)}`,
          )

          vi.setSystemTime(now + 1000)
          const replay = await outcomeOf(s.auth.refresh(lost))
          const sessionsAfter = [
            ...(i < k ? [await outcomeOf(s.auth.refresh(chain[k]!))] : []),
            await outcomeOf(s.auth.refresh(otherDevice)),
          ]
          const bystanderAfter = await outcomeOf(s.auth.refresh(bystander.first))

          expect(
            {
              forged,
              expired,
              otherDevice: otherDevice.startsWith('refused') ? otherDevice : 'ok',
            },
            'unknown jtis that fail the signature or expiry check',
          ).toEqual({
            forged: 'auth.token_invalid',
            expired: 'auth.token_invalid',
            otherDevice: 'ok',
          })
          expect(
            { replay, sessionsAfter, bystanderAfter },
            `R${i} of R0..R${k} presented ${presentedAfter} ms after R${k} with its row gone`,
          ).toEqual({
            replay: 'auth.token_invalid',
            sessionsAfter: sessionsAfter.map(() => 'auth.token_invalid'),
            bystanderAfter: 'ok',
          })
        },
      ),
      { numRuns: 15, examples: [[[1, 0], WINDOW_MS + 1000]] },
    )
  }, 60_000)
})
