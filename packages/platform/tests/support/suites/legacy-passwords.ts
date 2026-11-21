import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { AuthError } from '@nymbalhq/types'
import { runAsActor } from '../../../src/audit/actor.js'
import { createAuthService, hashResetToken } from '../../../src/services/auth-service.js'
import {
  expectedAcceptance,
  tagged,
  vector,
  type WordPressVector,
} from '../../../src/services/fixtures/wordpress-vectors.js'
import { startLegacyPasswordSweeper } from '../../../src/sweepers/index.js'
import { auditRows } from '../audit.js'
import type { Dialect } from '../kernel.js'
import { adminClient } from '../money.js'
import {
  login,
  me,
  openPasswordStore,
  truthy,
  type OpenStore,
  type PasswordStore,
} from '../password-reset.js'
import { unaudited } from '../write-audit.js'

// Imported WordPress password hashes on one dialect, against a kernel built from `src/` whose config opens the sunset
// window (`security.auth.legacy`): concurrent first sign-ins upgrade once, a reset, a sweep or a new import that lands
// between a sign-in's read and its write wins over it, a hash file never replaces a password set on Nymbal, and no
// hash leaves the server. Races are forced through a service whose read returns the row as it was, never timed.

export interface LegacyPasswordsSuiteOptions {
  open: OpenStore
  propertyRuns: number
}

const DAY_MS = 24 * 60 * 60_000
const IMPORTED_NO_PASSWORD = 'IMPORTED_NO_PASSWORD'
const NATIVE_HASH = bcrypt.hashSync('a-password-set-on-nymbal', 4)
const importer = { kind: 'import', id: 'woocommerce' } as const
const guest = { kind: 'guest', id: 'legacy-suite' } as const
const SIGN_IN = ['phpass ascii', 'wp bcrypt 10 ascii', 'bcrypt 10 ascii'].map(vector)

/** The UTC calendar date `days` from now. */
const dateIn = (days: number): string =>
  new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10)

function withLegacy(
  config: NymbalConfig,
  legacy: { until: string; maxCost: 10 | 11 | 12 },
): NymbalConfig {
  return { ...config, security: { ...config.security, auth: { ...config.security.auth, legacy } } }
}

async function openLegacyStore(open: OpenStore, until: string): Promise<PasswordStore> {
  return openPasswordStore((opts) =>
    open({
      ...opts,
      configure: (config) => withLegacy(opts.configure(config), { until, maxCost: 10 }),
    }),
  )
}

interface Legacy {
  id: string
  email: string
}

async function legacyCustomer(s: PasswordStore, hash: string, tag = 'wp'): Promise<Legacy> {
  const email = `${tag}-${randomUUID().slice(0, 8)}@legacy.test`
  const { id } = await runAsActor(importer, () => s.k.services.auth.importCustomer({ email }))
  const answer = await runAsActor(importer, () =>
    s.k.services.auth.importLegacyPassword({ email, recipe: 'wordpress', hash }),
  )
  expect(answer).toBe('stored')
  return { id, email }
}

const hashOf = async (s: PasswordStore, id: string): Promise<string> =>
  (
    await s.raw.one<{ password_hash: string }>('SELECT password_hash FROM customers WHERE id = ?', [
      id,
    ])
  ).password_hash

const entriesFor = async (s: PasswordStore, command: string, customerId: string) =>
  (await auditRows(s.raw, 'command = ?', [command])).filter((e) =>
    e.subjects.some((x) => x.type === 'customer' && x.id === customerId),
  )

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'signed in'
  } catch (error) {
    return error instanceof AuthError ? `${error.code}: ${error.message}` : `threw ${String(error)}`
  }
}
const REFUSED = 'auth.invalid_credentials: Invalid email or password'

/**
 * An auth service on the kernel's store whose first `findByEmail` answers `stale`: a sign-in that read the row just
 * before another write committed.
 */
function staleService(s: PasswordStore, stale: unknown, until: string) {
  const { repos } = s.k
  let first = true
  const customer = {
    ...repos.customer,
    findByEmail: (...args: Parameters<typeof repos.customer.findByEmail>) => {
      if (first) {
        first = false
        return Promise.resolve(stale as Awaited<ReturnType<typeof repos.customer.findByEmail>>)
      }
      return repos.customer.findByEmail(...args)
    },
  }
  return createAuthService({
    repos: { ...repos, customer },
    publisher: s.k.publisher,
    logger: s.k.logger,
    jwtSecret: s.k.config.security.auth.jwtSecret,
    accessTtl: s.k.config.security.auth.accessTtl,
    refreshTtl: s.k.config.security.auth.refreshTtl,
    legacy: { until: new Date(`${until}T00:00:00.000Z`), maxCost: 10 },
  })
}

async function resetLinkFor(s: PasswordStore, customerId: string): Promise<string> {
  const token = randomUUID()
  await s.k.store.transaction((tx) =>
    s.k.repos.passwordResetToken.insert(tx, {
      id: randomUUID(),
      customerId,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      createdAt: new Date(),
    }),
  )
  return token
}

type Kind = 'native' | 'pending' | 'sentinel' | 'tagged' | 'absent'

/** An email as a file line might write it. */
function cased(email: string, variant: 'lower' | 'upper' | 'mixed'): string {
  if (variant === 'lower') return email
  if (variant === 'upper') return email.toUpperCase()
  return Array.from(email, (c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('')
}

export function legacyPasswordsSuite(dialect: Dialect, options: LegacyPasswordsSuiteOptions): void {
  const until = dateIn(30)

  describe(`imported WordPress passwords (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openLegacyStore(options.open, until)
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    describe('AC-8: races between a first sign-in and other writes', () => {
      it('AC-8: property: k = 2 to 4 concurrent right-password sign-ins of one WordPress customer all sign in; exactly one conditional write takes, one customer.upgradePassword entry is recorded, and the final hash is native and verifies the password', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 2, max: 4 }),
            fc.constantFrom(...SIGN_IN),
            async (k, v) => {
              const c = await legacyCustomer(s, v.hash, `race-${k}`)
              const replace = vi.spyOn(
                s.k.repos.customer as unknown as {
                  replacePasswordHash: (...a: unknown[]) => Promise<boolean>
                },
                'replacePasswordHash',
              )
              try {
                const signedIn = await Promise.all(
                  Array.from({ length: k }, () =>
                    runAsActor(guest, () => s.k.services.auth.login(c.email, v.password)),
                  ),
                )
                const wrote = await Promise.all(
                  replace.mock.results.map((r) => r.value as Promise<boolean>),
                )
                const hash = await hashOf(s, c.id)

                expect(signedIn.map((r) => r.customer.id)).toEqual(signedIn.map(() => c.id))
                expect(wrote.filter((w) => w === true)).toHaveLength(1)
                expect(await entriesFor(s, 'customer.upgradePassword', c.id)).toHaveLength(1)
                expect([bcrypt.getRounds(hash), await bcrypt.compare(v.password, hash)]).toEqual([
                  10,
                  true,
                ])
              } finally {
                replace.mockRestore()
              }
            },
          ),
          { numRuns: Math.min(options.propertyRuns, 10) },
        )
      }, 120_000)

      it('AC-8: a reset that commits between a WordPress sign-in’s read and its write wins: the sign-in is refused, the row verifies the reset’s password and not the old one, and no customer.upgradePassword is recorded', async () => {
        for (const v of SIGN_IN) {
          const c = await legacyCustomer(s, v.hash, 'reset-race')
          const stale = await s.k.store.read((tx) => s.k.repos.customer.findByEmail(tx, c.email))
          const late = staleService(s, stale, until)
          const fresh = `reset-${randomUUID().slice(0, 8)}`
          await runAsActor(guest, async () =>
            s.k.services.auth.resetPassword(await resetLinkFor(s, c.id), fresh),
          )

          const answer = await runAsActor(guest, () => refusalOf(late.login(c.email, v.password)))
          const hash = await hashOf(s, c.id)
          expect([
            v.name,
            answer,
            await bcrypt.compare(fresh, hash),
            await bcrypt.compare(v.password, hash),
          ]).toEqual([v.name, REFUSED, true, false])
          expect(await entriesFor(s, 'customer.upgradePassword', c.id)).toEqual([])
        }
      }, 60_000)

      it('AC-8: a new WordPress hash imported between a sign-in’s read and its write wins: the sign-in is refused without checking the new value, though the same password would verify against it, and the row keeps the new value', async () => {
        const phpass = vector('phpass ascii')
        const wp = vector('wp bcrypt 10 ascii')
        expect(phpass.password).toBe(wp.password)
        const c = await legacyCustomer(s, phpass.hash, 'import-race')
        const stale = await s.k.store.read((tx) => s.k.repos.customer.findByEmail(tx, c.email))
        const late = staleService(s, stale, until)
        expect(
          await runAsActor(importer, () =>
            s.k.services.auth.importLegacyPassword({
              email: c.email,
              recipe: 'wordpress',
              hash: wp.hash,
            }),
          ),
        ).toBe('stored')

        const answer = await runAsActor(guest, () =>
          refusalOf(late.login(c.email, phpass.password)),
        )
        expect([answer, await hashOf(s, c.id)]).toEqual([REFUSED, tagged(wp.hash)])
        expect(await entriesFor(s, 'customer.upgradePassword', c.id)).toEqual([])
      }, 60_000)
    })

    describe('AC-9: a hash file never replaces a password set on Nymbal', () => {
      it('AC-9: property: over generated customers (registered, pending, imported without and with a hash, absent) and file lines (matched or not, accepted or not, case-varied), each answer is the rule’s, every row ends as the rule says, the answers add up to the lines, and customer.importLegacyPassword entries match stored answers one for one', async () => {
        const accepted = [
          'phpass ascii',
          'phpass 5 characters',
          'wp bcrypt 10 ascii',
          'bcrypt 10 utf-8',
        ].map((n) => vector(n).hash)
        const refused = [
          vector('wp bcrypt 12 ascii').hash,
          vector('wp bcrypt 11 ascii').hash,
          '5f4dcc3b5aa765d61d8327deb882cf99',
          `$H$${vector('phpass ascii').hash.slice(3)}`,
          ` ${vector('bcrypt 10 ascii').hash}`,
          `$argon2id$v=19$m=65536,t=4,p=1$c2FsdHNhbHQ$${'h'.repeat(43)}`,
        ]
        for (const h of accepted) expect(expectedAcceptance(h, 10).ok, h).toBe(true)
        for (const h of refused) expect(expectedAcceptance(h, 10).ok, h).toBe(false)

        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.constantFrom<Kind>('native', 'pending', 'sentinel', 'tagged', 'absent'), {
              minLength: 1,
              maxLength: 6,
            }),
            fc.array(
              fc.record({
                who: fc.nat(),
                hash: fc.constantFrom(...accepted, ...refused),
                variant: fc.constantFrom('lower' as const, 'upper' as const, 'mixed' as const),
              }),
              { minLength: 1, maxLength: 10 },
            ),
            async (kinds, lines) => {
              const run = randomUUID().slice(0, 8)
              const people = kinds.map((kind, i) => ({
                kind,
                email: `${kind}-${i}-${run}@file.test`,
                id: '',
              }))
              const now = new Date()
              for (const p of people) {
                if (p.kind === 'native' || p.kind === 'pending') {
                  p.id = randomUUID()
                  await unaudited(() =>
                    s.k.store.transaction((tx) =>
                      s.k.repos.customer.insert(tx, {
                        id: p.id,
                        email: p.email,
                        passwordHash: NATIVE_HASH,
                        ...(p.kind === 'pending' && { emailVerification: 'pending' as const }),
                        createdAt: now,
                        updatedAt: now,
                      }),
                    ),
                  )
                } else if (p.kind === 'sentinel') {
                  p.id = (
                    await runAsActor(importer, () =>
                      s.k.services.auth.importCustomer({ email: p.email }),
                    )
                  ).id
                } else if (p.kind === 'tagged') {
                  p.id = (await legacyCustomer(s, accepted[0]!, `tagged-${run}`)).id
                  p.email = (
                    await s.raw.one<{ email: string }>('SELECT email FROM customers WHERE id = ?', [
                      p.id,
                    ])
                  ).email
                }
              }
              const before = new Map(
                await Promise.all(
                  people
                    .filter((p) => p.id !== '')
                    .map(async (p) => [p.id, await hashOf(s, p.id)] as const),
                ),
              )
              const entriesBefore = new Set(
                (await auditRows(s.raw, 'command = ?', ['customer.importLegacyPassword'])).map(
                  (e) => e.id,
                ),
              )

              // The rule, run beside the store: refused first, then unknown, then a password of the store's own.
              const model = new Map(
                people.map((p) => [p.email, { kind: p.kind, stored: before.get(p.id) }]),
              )
              const expected: string[] = []
              const storedFor: string[] = []
              const answers: string[] = []
              for (const line of lines) {
                const p = people[line.who % people.length]!
                const m = model.get(p.email)!
                const want = !expectedAcceptance(line.hash, 10).ok
                  ? 'unsupported'
                  : m.kind === 'absent'
                    ? 'unmatched'
                    : m.kind === 'native' || m.kind === 'pending'
                      ? 'has-password'
                      : 'stored'
                if (want === 'stored') {
                  m.stored = tagged(line.hash)
                  storedFor.push(p.id)
                }
                expected.push(want)
                answers.push(
                  await runAsActor(importer, () =>
                    s.k.services.auth.importLegacyPassword({
                      email: cased(p.email, line.variant),
                      recipe: 'wordpress',
                      hash: line.hash,
                    }),
                  ),
                )
              }

              expect(answers).toEqual(expected)
              for (const p of people) {
                if (p.kind === 'absent') {
                  expect(
                    await s.raw.count('customers', 'lower(email) = ?', [p.email]),
                    p.email,
                  ).toBe(0)
                  continue
                }
                const row = await s.raw.one<{
                  password_hash: string
                  requires_password_reset: unknown
                }>('SELECT password_hash, requires_password_reset FROM customers WHERE id = ?', [
                  p.id,
                ])
                expect([p.kind, row.password_hash], p.email).toEqual([
                  p.kind,
                  model.get(p.email)!.stored,
                ])
                if (p.kind === 'sentinel' || p.kind === 'tagged') {
                  expect(truthy(row.requires_password_reset), p.email).toBe(true)
                }
              }
              const counts = ['stored', 'has-password', 'unmatched', 'unsupported'].map(
                (a) => answers.filter((x) => x === a).length,
              )
              expect(counts.reduce((a, b) => a + b, 0)).toBe(lines.length)
              const noted = (
                await auditRows(s.raw, 'command = ?', ['customer.importLegacyPassword'])
              )
                .filter((e) => !entriesBefore.has(e.id))
                .flatMap((e) => e.subjects.filter((x) => x.type === 'customer').map((x) => x.id))
              expect([...noted].sort()).toEqual([...storedFor].sort())
            },
          ),
          { numRuns: options.propertyRuns },
        )
      }, 180_000)
    })
  })

  describe(`imported WordPress passwords and the sweep (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openLegacyStore(options.open, until)
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    it('AC-8: a sweep that commits between a WordPress sign-in’s read and its write wins: the sign-in is refused, the row holds IMPORTED_NO_PASSWORD, and no customer.upgradePassword is recorded', async () => {
      const v = vector('phpass ascii')
      const c = await legacyCustomer(s, v.hash, 'sweep-race')
      const stale = await s.k.store.read((tx) => s.k.repos.customer.findByEmail(tx, c.email))
      const late = staleService(s, stale, until)
      const sweeper = startLegacyPasswordSweeper({
        store: s.k.store,
        customers: s.k.repos.customer,
        publisher: s.k.publisher,
        logger: s.k.logger,
        until: new Date(Date.now() - DAY_MS),
        intervalMs: 60 * 60_000,
      })
      try {
        await vi.waitFor(async () => expect(await hashOf(s, c.id)).toBe(IMPORTED_NO_PASSWORD), {
          timeout: 5_000,
          interval: 20,
        })
      } finally {
        sweeper.stop()
      }

      const answer = await runAsActor(guest, () => refusalOf(late.login(c.email, v.password)))
      expect([answer, await hashOf(s, c.id)]).toEqual([REFUSED, IMPORTED_NO_PASSWORD])
      expect(await entriesFor(s, 'customer.upgradePassword', c.id)).toEqual([])
    }, 60_000)
  })

  describe(`a WordPress hash never leaves the server (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openLegacyStore(options.open, until)
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    const secretsOf = (v: WordPressVector): string[] => {
      const salt =
        v.format === 'phpass'
          ? v.hash.slice(4, 12)
          : v.hash.slice(v.hash.length - 53, v.hash.length - 31)
      return [v.hash, salt, v.hash.slice(-31)]
    }

    it('AC-11: through refused and successful sign-ins, /me, the admin customer list, page, history and search, the import itself and a sweep, no response body, event, audit entry or log line at debug holds the source hash, its salt or the legacy: prefix', async () => {
      const signsIn = vector('phpass ascii')
      const stays = vector('wp bcrypt 10 utf-8')
      const logsBefore = s.logs.length
      const c = await legacyCustomer(s, signsIn.hash, 'leak')
      const kept = await legacyCustomer(s, stays.hash, 'kept')
      const admin = await adminClient(s.k, s.base)
      const bodies: Array<[string, number, string]> = []
      const record = (label: string, status: number, body: unknown) =>
        bodies.push([label, status, typeof body === 'string' ? body : JSON.stringify(body)])

      const refused = await login(s, c.email, 'not-the-wordpress-password')
      record('refused login', refused.status, refused.text)
      for (const [label, path] of [
        ['admin list', '/api/admin/customers?limit=200'],
        ['admin page', `/api/admin/customers/${c.id}`],
        ['admin history', `/api/admin/customers/${c.id}/history`],
        ['admin search', `/api/admin/search?q=${encodeURIComponent(c.email)}`],
        ['admin page (kept)', `/api/admin/customers/${kept.id}`],
      ] as const) {
        const res = await admin.call('GET', path)
        record(label, res.status, res.body)
      }
      const signedIn = await login(s, c.email, signsIn.password)
      record('login', signedIn.status, signedIn.text)
      const mine = await me(s, signedIn.body.data?.accessToken ?? '')
      record('me', mine.status, mine.text)
      const sweeper = startLegacyPasswordSweeper({
        store: s.k.store,
        customers: s.k.repos.customer,
        publisher: s.k.publisher,
        logger: s.k.logger,
        until: new Date(Date.now() - DAY_MS),
        intervalMs: 60 * 60_000,
      })
      try {
        await vi.waitFor(async () => expect(await hashOf(s, kept.id)).toBe(IMPORTED_NO_PASSWORD), {
          timeout: 5_000,
          interval: 20,
        })
      } finally {
        sweeper.stop()
      }

      expect(bodies.map(([label, status]) => [label, status])).toEqual([
        ['refused login', 401],
        ['admin list', 200],
        ['admin page', 200],
        ['admin history', 200],
        ['admin search', 200],
        ['admin page (kept)', 200],
        ['login', 200],
        ['me', 200],
      ])
      expect(bodies.find(([label]) => label === 'admin list')![2]).toContain(c.email)

      const secrets = [...secretsOf(signsIn), ...secretsOf(stays), 'legacy:']
      const events = (await s.raw.rows<Record<string, unknown>>('SELECT * FROM events')).map((r) =>
        JSON.stringify(r),
      )
      const audit = (await s.raw.rows<Record<string, unknown>>('SELECT * FROM audit_entries')).map(
        (r) => JSON.stringify(r),
      )
      const logs = s.logs.slice(logsBefore)
      const holding = (texts: string[]) =>
        secrets.filter((secret) => texts.some((t) => t.includes(secret)))
      expect({
        responses: holding(bodies.map(([, , body]) => body)),
        events: holding(events),
        audit: holding(audit),
        logs: holding(logs),
      }).toEqual({ responses: [], events: [], audit: [], logs: [] })
      expect(logs.length, 'the store logged at debug while this ran').toBeGreaterThan(bodies.length)
    }, 60_000)
  })
}
