import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { AuthError } from '@nymbalhq/types'
import { runAsActor } from '../../../src/audit/actor.js'
import { createAuthService, type AuthService } from '../../../src/services/auth-service.js'
import {
  createOldPlatformCheck,
  type OldPlatformCheck,
} from '../../../src/services/legacy-remote.js'
import { auditRows } from '../audit.js'
import { startOldPlatform, validTrue, type FakeOldPlatform } from '../../../src/tests/old-platform.js'
import { eventRows } from '../outbox.js'
import { openPasswordStore, type OpenStore, type PasswordStore } from '../password-reset.js'

// A shopper the store has no password for, signing in while the sunset window is open and the old platform's check
// is on: the sign-in service is built on a kernel's own store, publisher and logger, with the check pointed at an
// in-process fake old platform (or, where a test needs an answer the fake cannot force, a scripted check). Rows,
// events and audit entries are read by a second connection.

export const DAY_MS = 24 * 60 * 60_000
export const IMPORTED_NO_PASSWORD = 'IMPORTED_NO_PASSWORD'
export const REFUSED = 'auth.invalid_credentials: Invalid email or password'
export const OLD_PLATFORM_SECRET = `old-platform-${randomBytes(24).toString('base64url')}`
export const importer = { kind: 'import', id: 'woocommerce' } as const
export const guest = { kind: 'guest', id: 'old-platform-suite' } as const

/** The UTC calendar date `days` from now. */
export const dateIn = (days: number): string =>
  new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10)

export const tag = (): string => randomUUID().slice(0, 8)

export function withLegacy(config: NymbalConfig, until: string): NymbalConfig {
  return {
    ...config,
    security: {
      ...config.security,
      auth: { ...config.security.auth, legacy: { until, maxCost: 10 } },
    },
  }
}

export async function openOldPlatformStore(open: OpenStore): Promise<PasswordStore> {
  return openPasswordStore((opts) =>
    open({ ...opts, configure: (config) => withLegacy(opts.configure(config), dateIn(30)) }),
  )
}

/** The real check, against `fake`, logging through the kernel's logger. */
export function checkAgainst(s: PasswordStore, fake: FakeOldPlatform): OldPlatformCheck {
  return createOldPlatformCheck({ url: fake.url, secret: OLD_PLATFORM_SECRET, logger: s.k.logger })
}

/** A sign-in service on the kernel's store under `required`, with the window open until `until` and `remote` on. */
export function oldPlatformAuth(
  s: PasswordStore,
  remote: OldPlatformCheck,
  until: Date = new Date(Date.now() + 30 * DAY_MS),
): AuthService {
  return createAuthService({
    repos: s.k.repos,
    publisher: s.k.publisher,
    logger: s.k.logger,
    jwtSecret: s.k.config.security.auth.jwtSecret,
    accessTtl: s.k.config.security.auth.accessTtl,
    refreshTtl: s.k.config.security.auth.refreshTtl,
    verification: 'required',
    legacy: { until, maxCost: 10, remote },
    sleep: async () => undefined,
  })
}

export async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'signed in'
  } catch (error) {
    return error instanceof AuthError ? `${error.code}: ${error.message}` : `threw ${String(error)}`
  }
}

export async function markerCustomer(
  s: PasswordStore,
  profile: { firstName?: string; lastName?: string; phone?: string } = {},
): Promise<{ id: string; email: string }> {
  const email = `marker-${tag()}@old.test`
  const { id } = await runAsActor(importer, () =>
    s.k.services.auth.importCustomer({ email, ...profile }),
  )
  return { id, email }
}

export const customersAt = (s: PasswordStore, email: string): Promise<number> =>
  s.raw.count('customers', 'email = ?', [email])

/** Events of `type` (`customer.created.v1`, …) about one customer. */
export async function eventsAbout(s: PasswordStore, type: string, customerId: string) {
  return (await eventRows(s.raw, 'type = ?', [type])).filter(
    (e) => (e.envelope.payload as { customerId?: string }).customerId === customerId,
  )
}

export async function entriesFor(s: PasswordStore, command: string, customerId: string) {
  return (await auditRows(s.raw, 'command = ?', [command])).filter((e) =>
    e.subjects.some((x) => x.type === 'customer' && x.id === customerId),
  )
}

export interface OldPlatformSignInSuiteOptions {
  open: OpenStore
}

export function oldPlatformSignInSuite(
  dialect: string,
  options: OldPlatformSignInSuiteOptions,
): void {
  describe(`first sign-ins through the old platform racing each other (${dialect})`, () => {
    let s: PasswordStore
    let fake: FakeOldPlatform
    let auth: AuthService

    beforeAll(async () => {
      s = await openOldPlatformStore(options.open)
      fake = await startOldPlatform()
      auth = oldPlatformAuth(s, checkAgainst(s, fake))
    }, 60_000)

    afterAll(async () => {
      await fake?.close()
      await s?.close()
    })

    /**
     * Two sign-ins for one address, both held at the old platform until both have asked (or either has settled
     * without asking), then answered `ok`. Each is its result, or the refusal it ended in.
     */
    async function together(email: string, password: string) {
      fake.reply = () => validTrue({ firstName: 'Twin' })
      fake.hold.hold()
      const both = [0, 1].map(() => runAsActor(guest, () => auth.login(email, password)))
      try {
        await Promise.race([fake.hold.waiting(2), Promise.allSettled(both)])
      } finally {
        fake.hold.release()
      }
      const settled = await Promise.allSettled(both)
      return settled.map((r) => (r.status === 'fulfilled' ? r.value : null))
    }

    async function refreshedSubjects(signedIn: Array<{ tokens: { refreshToken: string } } | null>) {
      return Promise.all(
        signedIn.map(async (r) => {
          if (r === null) return null
          const tokens = await auth.refresh(r.tokens.refreshToken)
          return (await auth.verifyAccessToken(tokens.accessToken)).sub
        }),
      )
    }

    it('AC-12: two first sign-ins at once for one unknown address both sign in; one customer row and one customer.created exist, and each refresh token refreshes', async () => {
      const email = `twin-${tag()}@old.test`
      const asked = fake.requests.length
      const signedIn = await together(email, 'old-platform-twin-password')
      const ids = signedIn.map((r) => r?.customer.id ?? 'refused')
      const refreshed = await refreshedSubjects(signedIn)
      const [row] = await s.raw.rows<{ id: string }>('SELECT id FROM customers WHERE email = ?', [
        email,
      ])

      expect([fake.requests.length - asked, ids]).toEqual([2, [row?.id, row?.id]])
      expect(await customersAt(s, email)).toBe(1)
      expect(await eventsAbout(s, 'customer.created.v1', row!.id)).toHaveLength(1)
      expect(refreshed).toEqual(ids)
    }, 30_000)

    it('AC-12: two first sign-ins at once for a marker customer both sign in; one write takes', async () => {
      const c = await markerCustomer(s)
      const asked = fake.requests.length
      const signedIn = await together(c.email, 'old-platform-marker-password')
      const refreshed = await refreshedSubjects(signedIn)
      expect([
        fake.requests.length - asked,
        signedIn.map((r) => r?.customer.id ?? 'refused'),
      ]).toEqual([2, [c.id, c.id]])
      expect(refreshed).toEqual([c.id, c.id])
      expect(await customersAt(s, c.email)).toBe(1)
      expect(await eventsAbout(s, 'customer.updated.v1', c.id)).toHaveLength(1)
      expect(await entriesFor(s, 'customer.oldPlatformSignIn', c.id)).toHaveLength(1)
    }, 30_000)
  })
}
