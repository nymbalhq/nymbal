import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { runAsActor } from '../audit/actor.js'
import { createCommandStore, rawClients, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import { buildRepositories, type Repositories } from '../repositories/index.js'
import { wirePublisher } from '../tests/publisher.js'
import {
  createAuthService,
  DUMMY_PASSWORD,
  hashResetToken,
  PASSWORD_HASH_ROUNDS,
  PASSWORD_MIN_LENGTH,
  type AuthService,
} from './auth-service.js'
import { innerEdit, tagged, vector, type WordPressVector } from './fixtures/wordpress-vectors.js'

// An imported WordPress customer signs in once with their WordPress password and holds a native bcrypt afterwards; a
// wrong password changes nothing; the old hash is honoured only before the store's sunset date; a reset replaces it.
// Real bcrypt, real phpass, a SQLite command store per test.

const DAY_MS = 24 * 60 * 60_000
const IMPORTED_NO_PASSWORD = 'IMPORTED_NO_PASSWORD'
const SIGN_IN_FORMATS = ['phpass ascii', 'wp bcrypt 10 ascii', 'bcrypt 10 ascii'] as const

interface LegacyDeps {
  until?: Date
  maxCost: 10 | 11 | 12
}

async function openStore() {
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
  const { publisher } = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
  )
  /** An auth service over this store, with the legacy window it is given (none when absent). */
  const service = (legacy?: LegacyDeps): AuthService =>
    createAuthService({
      repos,
      publisher,
      logger,
      jwtSecret: 'test-secret-32-characters-long-x',
      accessTtl: '15m',
      refreshTtl: '7d',
      ...(legacy !== undefined && { legacy }),
    })
  return { store, repos, service }
}

type Store = Awaited<ReturnType<typeof openStore>>

const open: CommandStore[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const store of open.splice(0)) await store.close()
})

async function storeWith(): Promise<Store> {
  const s = await openStore()
  open.push(s.store)
  return s
}

const future = (): Date => new Date(Date.now() + 30 * DAY_MS)

/** An imported customer holding `hash` from WordPress through importLegacyPassword. */
async function legacyCustomer(
  auth: AuthService,
  hash: string,
  tag = 'wp',
): Promise<{ id: string; email: string }> {
  const email = `${tag}-${randomUUID().slice(0, 8)}@legacy.test`
  const customer = await auth.importCustomer({ email })
  expect(await auth.importLegacyPassword({ email, recipe: 'wordpress', hash })).toBe('stored')
  return { id: customer.id, email }
}

/** Every column of the customer's row, as the store holds it. */
function rowOf(s: Store, id: string): Record<string, unknown> {
  const clients = rawClients(s.store)
  if (clients.kind !== 'sqlite') throw new Error('this file runs on SQLite')
  return clients.raw.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Record<
    string,
    unknown
  >
}

function refreshRows(s: Store): number {
  const clients = rawClients(s.store)
  if (clients.kind !== 'sqlite') throw new Error('this file runs on SQLite')
  return (clients.raw.prepare('SELECT count(*) AS n FROM refresh_tokens').get() as { n: number }).n
}

/** What a sign-in answered: signed in, or the AuthError's code and message, or what else it threw. */
async function refusalOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
    return { code: 'signed in', message: '' }
  } catch (error) {
    if (error instanceof AuthError) return { code: error.code, message: error.message }
    return { code: `threw ${String(error)}`, message: '' }
  }
}

const upgrades = async (s: Store, customerId: string): Promise<number> =>
  (await s.store.read((tx) => listAuditEntries(tx, { order: 'asc', limit: 500 }))).filter(
    (e) => e.command === 'customer.upgradePassword' && e.subjects.some((x) => x.id === customerId),
  ).length

const guest = { kind: 'guest', id: 'guest-1' } as const

describe('AC-3: the right WordPress password signs in once and leaves a native hash', () => {
  const cases: Array<{ name: string; maxCost: 10 | 12 }> = [
    ...SIGN_IN_FORMATS.map((name) => ({ name, maxCost: 10 as const })),
    { name: 'wp bcrypt 12 ascii', maxCost: 12 },
  ]
  for (const { name, maxCost } of cases) {
    it(`AC-3: ${name} at maxCost ${maxCost}: login with the right password issues tokens, the row then holds a native bcrypt at PASSWORD_HASH_ROUNDS that verifies the password, the flag is false and nothing starts with legacy:; the next sign-in is native and the WordPress hash itself is refused`, async () => {
      const s = await storeWith()
      const auth = s.service({ until: future(), maxCost })
      const v = vector(name)
      const { id, email } = await legacyCustomer(auth, v.hash)
      const sessionsBefore = refreshRows(s)

      const first = await auth.login(email, v.password)
      const upgraded = rowOf(s, id)
      const hash = String(upgraded['password_hash'])

      expect(first.customer.id).toBe(id)
      expect(first.tokens.refreshToken).toEqual(expect.any(String))
      expect(refreshRows(s)).toBe(sessionsBefore + 1)
      expect(bcrypt.getRounds(hash)).toBe(PASSWORD_HASH_ROUNDS)
      expect(await bcrypt.compare(v.password, hash)).toBe(true)
      expect(Boolean(upgraded['requires_password_reset'])).toBe(false)
      expect(
        Object.entries(upgraded).filter(([, value]) => String(value).includes('legacy:')),
      ).toEqual([])

      const second = await auth.login(email, v.password)
      expect(second.customer.id).toBe(id)
      expect(rowOf(s, id)['password_hash'], 'a native sign-in rewrites nothing').toBe(hash)
      expect(await refusalOf(auth.login(email, v.hash))).toEqual({
        code: 'auth.invalid_credentials',
        message: 'Invalid email or password',
      })
    }, 30_000)
  }

  it('AC-3: a WordPress password shorter than PASSWORD_MIN_LENGTH signs in and becomes a native hash of it', async () => {
    const s = await storeWith()
    const auth = s.service({ until: future(), maxCost: 10 })
    const short: WordPressVector[] = [
      vector('phpass 5 characters'),
      vector('wp bcrypt 10 5 characters'),
    ]
    for (const v of short) {
      expect(Array.from(v.password).length).toBeLessThan(PASSWORD_MIN_LENGTH)
      const { id, email } = await legacyCustomer(auth, v.hash, 'short')
      const signedIn = await auth.login(email, v.password)
      const hash = String(rowOf(s, id)['password_hash'])
      expect([
        signedIn.customer.id,
        bcrypt.getRounds(hash),
        await bcrypt.compare(v.password, hash),
      ]).toEqual([id, PASSWORD_HASH_ROUNDS, true])
    }
  }, 30_000)

  it('AC-3: a WordPress password typed with a trailing space signs in, and the native hash then verifies it as typed, space included', async () => {
    const s = await storeWith()
    const auth = s.service({ until: future(), maxCost: 10 })
    for (const name of SIGN_IN_FORMATS) {
      const v = vector(name)
      const typed = `${v.password} `
      const { id, email } = await legacyCustomer(auth, v.hash, 'space')
      const signedIn = await auth.login(email, typed)
      const hash = String(rowOf(s, id)['password_hash'])
      expect([
        name,
        signedIn.customer.id,
        await bcrypt.compare(typed, hash),
        await bcrypt.compare(v.password, hash),
      ]).toEqual([name, id, true, false])
      expect((await auth.login(email, typed)).customer.id).toBe(id)
    }
  }, 30_000)
})

describe('AC-4: a wrong password never upgrades', () => {
  for (const name of SIGN_IN_FORMATS) {
    it(`AC-4: against a ${name} customer, generated wrong passwords (inner edits, DUMMY_PASSWORD, IMPORTED_NO_PASSWORD, the stored legacy: value, the bare hash) are refused with a known address's answer, leave the row and the sessions as they were, and record no customer.upgradePassword`, async () => {
      const s = await storeWith()
      const auth = s.service({ until: future(), maxCost: 10 })
      const v = vector(name)
      const known = `known-${randomUUID().slice(0, 8)}@legacy.test`
      await auth.register({ email: known, password: 'known-correct-horse' })
      const knownAnswer = await refusalOf(auth.login(known, 'known-wrong-horse'))
      const { id, email } = await legacyCustomer(auth, v.hash)
      const before = rowOf(s, id)
      const sessions = refreshRows(s)

      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            innerEdit(v.password),
            fc.constantFrom(DUMMY_PASSWORD, IMPORTED_NO_PASSWORD, tagged(v.hash), v.hash),
          ),
          async (wrong) => {
            const answer = await runAsActor(guest, () => refusalOf(auth.login(email, wrong)))
            const after = rowOf(s, id)
            expect(answer, JSON.stringify(wrong)).toEqual(knownAnswer)
            expect([after['password_hash'], after['requires_password_reset']]).toEqual([
              before['password_hash'],
              before['requires_password_reset'],
            ])
            expect(refreshRows(s)).toBe(sessions)
            expect(await upgrades(s, id)).toBe(0)
          },
        ),
        { numRuns: 20 },
      )
      expect(knownAnswer.code).toBe('auth.invalid_credentials')
    }, 60_000)
  }
})

describe('AC-7: the sunset date, at the service', () => {
  it('AC-7: one millisecond before until the right WordPress password signs in and upgrades; at until and a day later it is refused as an imported customer with no password is, and the row is unchanged', async () => {
    const s = await storeWith()
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.parse('2026-11-19T10:00:00.000Z')
    vi.setSystemTime(t0)
    const until = new Date(t0 + 10 * DAY_MS)
    const auth = s.service({ until, maxCost: 10 })
    const v = vector('phpass ascii')
    const early = await legacyCustomer(auth, v.hash, 'early')
    const late = await legacyCustomer(auth, v.hash, 'late')
    const imported = `imported-${randomUUID().slice(0, 8)}@legacy.test`
    await auth.importCustomer({ email: imported })
    const lateBefore = rowOf(s, late.id)

    vi.setSystemTime(until.getTime() - 1)
    const signedIn = await auth.login(early.email, v.password)
    const earlyHash = String(rowOf(s, early.id)['password_hash'])
    expect([signedIn.customer.id, bcrypt.getRounds(earlyHash)]).toEqual([
      early.id,
      PASSWORD_HASH_ROUNDS,
    ])

    for (const at of [until.getTime(), until.getTime() + DAY_MS]) {
      vi.setSystemTime(at)
      const noPassword = await refusalOf(auth.login(imported, v.password))
      expect(
        await refusalOf(auth.login(late.email, v.password)),
        new Date(at).toISOString(),
      ).toEqual(noPassword)
      expect(rowOf(s, late.id)).toEqual(lateBefore)
    }
  }, 30_000)

  it('AC-7: a service with no until refuses the right WordPress password, whether it has no legacy block or one with only maxCost, and leaves the row unchanged', async () => {
    const s = await storeWith()
    const importer = s.service({ until: future(), maxCost: 10 })
    const v = vector('wp bcrypt 10 ascii')
    const c = await legacyCustomer(importer, v.hash)
    const imported = `imported-${randomUUID().slice(0, 8)}@legacy.test`
    await importer.importCustomer({ email: imported })
    const before = rowOf(s, c.id)

    for (const auth of [s.service(), s.service({ maxCost: 10 })]) {
      const noPassword = await refusalOf(auth.login(imported, v.password))
      expect(await refusalOf(auth.login(c.email, v.password))).toEqual(noPassword)
      expect(rowOf(s, c.id)).toEqual(before)
    }
    expect(
      (await importer.login(c.email, v.password)).customer.id,
      'the same row signs in inside a window',
    ).toBe(c.id)
  }, 30_000)
})

describe('AC-13: a reset replaces the WordPress hash', () => {
  it('AC-13: a legacy customer who resets through a mailed link before until signs in with the new password; the WordPress password is refused afterwards, the hash is native with no legacy:, and the flag is false', async () => {
    const s = await storeWith()
    const auth = s.service({ until: future(), maxCost: 10 })
    for (const name of SIGN_IN_FORMATS) {
      const v = vector(name)
      const { id, email } = await legacyCustomer(auth, v.hash, 'reset')
      const token = await resetLink(s.repos, s.store, id)
      const fresh = `fresh-${randomUUID().slice(0, 8)}`

      await auth.resetPassword(token, fresh)
      const row = rowOf(s, id)
      expect((await auth.login(email, fresh)).customer.id).toBe(id)
      expect(await refusalOf(auth.login(email, v.password))).toEqual({
        code: 'auth.invalid_credentials',
        message: 'Invalid email or password',
      })
      expect([
        name,
        bcrypt.getRounds(String(row['password_hash'])),
        String(row['password_hash']).includes('legacy:'),
        Boolean(row['requires_password_reset']),
      ]).toEqual([name, PASSWORD_HASH_ROUNDS, false, false])
    }
  }, 30_000)
})

// Every compare is handed at most the first 72 code points of the typed password. Bcrypt reads only the first 72 bytes,
// which those always hold, so the cut must never change a native answer either.
describe('AC-1: the 72-code-point cut changes no native answer', () => {
  it('AC-1: a registered customer whose password has multi-byte characters across the 72nd byte signs in with it, and is refused with one differing inside the first 72 bytes', async () => {
    const s = await storeWith()
    const auth = s.service({ until: future(), maxCost: 12 })
    const wide = fc.constantFrom('é', 'ж', '€', '中', '🦊', '𝄞')
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 62, max: 71 }),
        fc.array(wide, { minLength: 3, maxLength: 6 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (prefix, bridge, tail) => {
          const password = `${'p'.repeat(prefix)}${bridge.join('')}${tail.trim() || 't'}`
          const email = `cut-${randomUUID().slice(0, 8)}@legacy.test`
          await auth.register({ email, password })
          const inside = `${'p'.repeat(prefix - 1)}q${password.slice(prefix)}`
          expect((await auth.login(email, password)).customer.email).toBe(email)
          expect((await refusalOf(auth.login(email, inside))).code).toBe('auth.invalid_credentials')
        },
      ),
      {
        numRuns: 6,
        // 71 one-byte characters and then a 4-byte one: a cut by UTF-16 units ends inside its surrogate pair.
        examples: [
          [71, ['🦊', 'é', '中'], 'tail'],
          [71, ['𝄞'], 'x'],
        ],
      },
    )
  }, 60_000)
})

async function resetLink(
  repos: Repositories,
  store: CommandStore,
  customerId: string,
): Promise<string> {
  const token = randomUUID()
  await store.transaction((tx) =>
    repos.passwordResetToken.insert(tx, {
      id: randomUUID(),
      customerId,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      createdAt: new Date(),
    }),
  )
  return token
}
