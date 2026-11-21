import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { expect } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { TransactionalEmail } from '@nymbalhq/types'
import { adminClient, type AdminClient } from './money.js'
import {
  call,
  delivered,
  openPasswordStore,
  refreshRowsOf,
  resetRowsOf,
  type Answer,
  type CallOptions,
  type OpenStore,
  type PasswordStore,
  type StoreOptions,
} from './password-reset.js'
import { writeRaw } from './raw.js'
import { unaudited } from './write-audit.js'

// A store for the sign-up journeys: the password store (tests/support/password-reset.ts: a kernel served over HTTP whose
// email slot is a capturing adapter of the tests' own, every log line kept) with `security.auth.verification` set as
// the test asks, and the verification routes' per-address limits raised so a suite can call them many times from
// 127.0.0.1 (the built-in bounds are the http package's). Mail is read from the adapter the handler calls, rows from a
// second connection.

export const REGISTER = '/api/auth/register'
export const VERIFY = '/api/auth/verify-email'
export const RESEND = '/api/auth/resend-verification'
export const MAIL_HEALTH = '/api/admin/mail-health'
export const VERIFY_MAIL = 'verify-email'
export const EXISTS_MAIL = 'account-exists'
export const VERIFICATION_REQUESTED = 'customer.verification_requested.v1'
export const REGISTERED_AGAIN = 'customer.registered_again.v1'
export const VERIFY_INVALID = 'auth.verify_link_invalid'
/** The one answer a register gets under `required`, whatever the address. */
export const SENT = { data: { verification: 'sent', expiresHours: 24 } }
/** The one answer a resend gets, whatever the address and the policy. */
export const RESEND_ANSWER = { data: { sent: 'if-matched' } }
export const VERIFY_TTL_MS = 24 * 60 * 60_000
export const REISSUE_MS = 15 * 60_000
/** A verification link: the store's URL, the page, and 32 random bytes as base64url in the fragment. */
export const VERIFY_LINK = /^https:\/\/shop\.test\/account\/verify-email#token=([A-Za-z0-9_-]{43})$/

const RAISED = { requests: 100_000, window: '1m', action: 'block' } as const

export type Policy = 'required' | 'off'

export interface VerificationStoreOptions extends Omit<StoreOptions, 'rateLimit'> {
  /** `security.auth.verification`; absent leaves the store to resolve it from its email adapter. */
  verification?: Policy
}

/** The store's config with the policy set, as a store's file would set it. */
function withPolicy(config: NymbalConfig, verification: Policy | undefined): NymbalConfig {
  if (verification === undefined) return config
  return {
    ...config,
    security: { ...config.security, auth: { ...config.security.auth, verification } },
  } as NymbalConfig
}

export async function openVerificationStore(
  open: OpenStore,
  opts: VerificationStoreOptions = {},
): Promise<PasswordStore> {
  const { verification, ...rest } = opts
  const policed: OpenStore = (o) =>
    open({ ...o, configure: (config) => withPolicy(o.configure(config), verification) })
  return openPasswordStore(policed, {
    ...rest,
    rateLimit: (config) => ({
      ...config.security.rateLimit,
      '/api/auth/forgot-password': RAISED,
      '/api/auth/reset-password': RAISED,
      '/api/customers/me/password': RAISED,
      [VERIFY]: RAISED,
      [RESEND]: RAISED,
    }),
  })
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Registration {
  email: string
  password: string
  firstName?: string
  lastName?: string
  phone?: string
}

export const register = (s: PasswordStore, body: Registration, opts?: CallOptions) =>
  call(s, 'POST', REGISTER, body, opts)

export const verify = (s: PasswordStore, token: string, opts?: CallOptions) =>
  call(s, 'POST', VERIFY, { token }, opts)

export const resend = (s: PasswordStore, email: string, opts?: CallOptions) =>
  call(s, 'POST', RESEND, { email }, opts)

/** The names of the headers an answer carried, sorted: what a caller could tell two answers apart by. */
export const headerNames = (a: Answer): string[] => [...a.headers.keys()].sort()

// ─── Customers ────────────────────────────────────────────────────────────────────────────────────────────────────

export const newAddress = (tag: string): string => `${tag}-${randomUUID().slice(0, 8)}@verify.test`

export const newPassword = (tag: string): string => `${tag}-${randomUUID().slice(0, 12)}`

export async function customerIdOf(s: PasswordStore, email: string): Promise<string> {
  const row = await s.raw.one<{ id: string }>('SELECT id FROM customers WHERE email = ?', [
    email.toLowerCase(),
  ])
  return row.id
}

export interface SignedUp {
  customerId: string
  email: string
  password: string
  /** The token of the verification mail the sign-up sent. */
  token: string
}

/** A new address registered over HTTP under `required`, delivered, with the one verification mail it sent. */
export async function signedUp(
  s: PasswordStore,
  tag: string,
  extra: Omit<Registration, 'email' | 'password'> = {},
): Promise<SignedUp> {
  const email = newAddress(tag)
  const password = newPassword(tag)
  const answer = await register(s, { email, password, ...extra })
  expect(answer.status, `register ${email}: ${answer.text.slice(0, 160)}`).toBe(202)
  await delivered(s)
  const mails = verifyMailsTo(s, email)
  expect(mails.length, `verification mails to ${email}`).toBe(1)
  return {
    customerId: await customerIdOf(s, email),
    email,
    password,
    token: verifyTokenIn(mails[0]),
  }
}

/** A signed-up address whose link was followed: a confirmed account. */
export async function confirmed(s: PasswordStore, tag: string): Promise<SignedUp> {
  const shopper = await signedUp(s, tag)
  const answer = await verify(s, shopper.token)
  expect(answer.status, `verify ${shopper.email}: ${answer.text.slice(0, 160)}`).toBe(200)
  await delivered(s)
  return shopper
}

/** An account inserted as the seed inserts the demo account: no confirmation field at all. */
export async function seeded(
  s: PasswordStore,
  tag: string,
): Promise<{ customerId: string; email: string; password: string }> {
  const customerId = randomUUID()
  const email = newAddress(tag)
  const password = newPassword(tag)
  const now = new Date()
  await unaudited(() =>
    s.k.store.transaction((tx) =>
      s.k.repos.customer.insert(tx, {
        id: customerId,
        email,
        passwordHash: bcrypt.hashSync(password, 4),
        roles: ['customer'],
        requiresPasswordReset: false,
        createdAt: now,
        updatedAt: now,
      }),
    ),
  )
  return { customerId, email, password }
}

/** An account made by the `off` sign-up, through the service: never asked to confirm. */
export async function registeredUnasked(
  s: PasswordStore,
  tag: string,
): Promise<{ customerId: string; email: string; password: string }> {
  const email = newAddress(tag)
  const password = newPassword(tag)
  const { customer } = await s.k.services.auth.register({ email, password })
  await delivered(s)
  return { customerId: customer.id, email, password }
}

export const adminOf = (s: PasswordStore): Promise<AdminClient> => adminClient(s.k, s.base)

// ─── Rows, mail ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface VerificationRow {
  id: string
  customer_id: string
  token_hash: string
  expires_at: unknown
  created_at: unknown
}

export const verificationRowsOf = (
  s: PasswordStore,
  customerId: string,
): Promise<VerificationRow[]> =>
  s.raw.rows<VerificationRow>(
    'SELECT id, customer_id, token_hash, expires_at, created_at FROM email_verification_tokens WHERE customer_id = ? ORDER BY id',
    [customerId],
  )

/** `customers.email_verification` as stored: null, 'pending' or 'verified'. */
export async function verificationOf(s: PasswordStore, customerId: string): Promise<unknown> {
  const row = await s.raw.one<{ email_verification: unknown }>(
    'SELECT email_verification FROM customers WHERE id = ?',
    [customerId],
  )
  return row.email_verification
}

/** Everything a register must leave as it was on an account it may not write: its row, sessions and link rows. */
export async function accountStateOf(s: PasswordStore, customerId: string) {
  return {
    customer: await s.raw.one<Record<string, unknown>>('SELECT * FROM customers WHERE id = ?', [
      customerId,
    ]),
    sessions: await refreshRowsOf(s, customerId),
    resets: await resetRowsOf(s, customerId),
    verifications: await verificationRowsOf(s, customerId),
  }
}

/** Moves a customer's verification rows' `created_at` to `at`. */
export const setLinkCreatedAt = (s: PasswordStore, customerId: string, at: Date): Promise<void> =>
  writeRaw(
    s.k.dialect,
    s.k.target,
    'UPDATE email_verification_tokens SET created_at = ? WHERE customer_id = ?',
    [at.toISOString(), customerId],
  )

/** Ends a customer's verification links, as time would. */
export const expireLinks = (s: PasswordStore, customerId: string): Promise<void> =>
  writeRaw(
    s.k.dialect,
    s.k.target,
    'UPDATE email_verification_tokens SET expires_at = ? WHERE customer_id = ?',
    [new Date(Date.now() - 1_000).toISOString(), customerId],
  )

/** Moves a customer's `created_at` to `at`, as an account made that long ago would read. */
export const setCustomerCreatedAt = (
  s: PasswordStore,
  customerId: string,
  at: Date,
): Promise<void> =>
  writeRaw(s.k.dialect, s.k.target, 'UPDATE customers SET created_at = ? WHERE id = ?', [
    at.toISOString(),
    customerId,
  ])

export const verifyMailsTo = (s: PasswordStore, to: string): TransactionalEmail[] =>
  s.mail.sent.filter((m) => m.template === VERIFY_MAIL && m.to === to)

export const existsMailsTo = (s: PasswordStore, to: string): TransactionalEmail[] =>
  s.mail.sent.filter((m) => m.template === EXISTS_MAIL && m.to === to)

/** The token in a verification mail's link; the journey depends on it. */
export function verifyTokenIn(mail: TransactionalEmail | undefined): string {
  const url = String(mail?.vars['verifyUrl'] ?? '')
  const match = VERIFY_LINK.exec(url)
  expect(match, `the verification link: ${url}`).not.toBeNull()
  return match![1]!
}
