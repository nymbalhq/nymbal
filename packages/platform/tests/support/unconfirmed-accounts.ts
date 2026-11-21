import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { EVT_CUSTOMER_DELETED } from '@nymbalhq/types'
import {
  startUnconfirmedAccountSweeper,
  type SweeperHandle,
  type UnconfirmedAccountSweeperDeps,
} from '../../src/sweepers/index.js'
import { auditRows, type AuditRow } from './audit.js'
import { eventRows } from './outbox.js'
import { msOf, neverIssued, sha256, type PasswordStore } from './password-reset.js'
import { writeRaw } from './raw.js'
import { newAddress } from './verification.js'
import { unaudited } from './write-audit.js'

// What the tests of the unconfirmed-account purge write and read on a verification store (tests/support/verification.ts):
// rows aged as the running service would have left them that long ago, credential rows of any age, and what a removal
// leaves behind (the row, its credential rows, its `customer.deleted.v1` and its audit entry), read from a second
// connection.

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
export const PURGE_COMMAND = 'customer.purgeUnconfirmed'

export const daysBefore = (at: Date, days: number): Date => new Date(at.getTime() - days * DAY_MS)

/** Sets a customer's `created_at` and `updated_at`, as a row last written at `updated` would read. */
export const age = (s: PasswordStore, customerId: string, created: Date, updated: Date = created) =>
  writeRaw(
    s.k.dialect,
    s.k.target,
    'UPDATE customers SET created_at = ?, updated_at = ? WHERE id = ?',
    [created.toISOString(), updated.toISOString(), customerId],
  )

/** Deletes a customer's verification rows: an account whose link is long gone. */
export const dropLinks = (s: PasswordStore, customerId: string) =>
  writeRaw(s.k.dialect, s.k.target, 'DELETE FROM email_verification_tokens WHERE customer_id = ?', [
    customerId,
  ])

/** Sets `email_verification` as stored, for a state the policy in force would not make. */
export const setVerification = (
  s: PasswordStore,
  customerId: string,
  value: 'pending' | 'verified',
) =>
  writeRaw(s.k.dialect, s.k.target, 'UPDATE customers SET email_verification = ? WHERE id = ?', [
    value,
    customerId,
  ])

/** A pending account inserted as the `required` sign-up inserts one, last written `days` before now, with no link. */
export async function agedPending(
  s: PasswordStore,
  tag: string,
  days: number,
): Promise<{ customerId: string; email: string }> {
  const customerId = uuidv7()
  const email = newAddress(tag)
  const at = daysBefore(new Date(), days)
  await unaudited(() =>
    s.k.store.transaction((tx) =>
      s.k.repos.customer.insert(tx, {
        id: customerId,
        email,
        passwordHash: `unused-${randomUUID()}`,
        emailVerification: 'pending',
        createdAt: at,
        updatedAt: at,
      }),
    ),
  )
  return { customerId, email }
}

export type CredentialTable =
  | 'refresh_tokens'
  | 'password_reset_tokens'
  | 'email_verification_tokens'
export const CREDENTIAL_TABLES: readonly CredentialTable[] = [
  'refresh_tokens',
  'password_reset_tokens',
  'email_verification_tokens',
]

/** One row in a credential table for the customer, expiring at `expiresAt`. */
export async function credential(
  s: PasswordStore,
  table: CredentialTable,
  customerId: string,
  expiresAt: Date,
): Promise<void> {
  const row = {
    id: uuidv7(),
    customerId,
    tokenHash: sha256(neverIssued()),
    expiresAt,
    createdAt: new Date(expiresAt.getTime() - DAY_MS),
  }
  await unaudited(() =>
    s.k.store.transaction((tx) =>
      table === 'refresh_tokens'
        ? s.k.repos.refreshToken.insert(tx, row)
        : table === 'password_reset_tokens'
          ? s.k.repos.passwordResetToken.insert(tx, row)
          : s.k.repos.emailVerificationToken.insert(tx, row),
    ),
  )
}

/** How many rows the customer has in each credential table, in `CREDENTIAL_TABLES` order. */
export async function credentialCounts(s: PasswordStore, customerId: string): Promise<number[]> {
  const counts: number[] = []
  for (const table of CREDENTIAL_TABLES) {
    counts.push(await s.raw.count(table, 'customer_id = ?', [customerId]))
  }
  return counts
}

/** How many of the customer's rows in `table` still open something at `at`. */
export async function liveRows(
  s: PasswordStore,
  table: CredentialTable,
  customerId: string,
  at: Date,
): Promise<number> {
  const rows = await s.raw.rows<{ expires_at: unknown }>(
    `SELECT expires_at FROM ${table} WHERE customer_id = ?`,
    [customerId],
  )
  return rows.filter((r) => msOf(r.expires_at) > at.getTime()).length
}

export const customerRows = (s: PasswordStore, customerId: string): Promise<number> =>
  s.raw.count('customers', 'id = ?', [customerId])

/** The payloads of the `customer.deleted.v1` rows in the log for this customer. */
export async function deletionsOf(s: PasswordStore, customerId: string): Promise<unknown[]> {
  return (await eventRows(s.raw, 'type = ?', [EVT_CUSTOMER_DELETED]))
    .map((row) => row.envelope.payload as { customerId?: string })
    .filter((payload) => payload.customerId === customerId)
}

/** The purge's audit entries that name this customer. */
export async function purgeEntriesOf(s: PasswordStore, customerId: string): Promise<AuditRow[]> {
  return (await auditRows(s.raw, 'command = ?', [PURGE_COMMAND])).filter((row) =>
    row.subjects.some((subject) => subject.id === customerId),
  )
}

/** The log lines at error level or above (pino's 50 and 60). */
export const errorLines = (lines: readonly string[]): string[] =>
  lines.filter((line) => /"level":(50|60)\b/.test(line))

export type SweeperOptions = Partial<Omit<UnconfirmedAccountSweeperDeps, 'now'>> & {
  /** The pass's clock: every tick runs at this instant. */
  at: Date
}

/**
 * Sweepers a test starts on a store, each on the store's own command store, repositories, publisher, logger and
 * resolved policy unless the test passes its own; an hourly interval, so only the test's ticks run. `stopAll` in an
 * afterEach.
 */
export function sweepers() {
  const started: SweeperHandle[] = []
  return {
    start(s: PasswordStore, opts: SweeperOptions): SweeperHandle {
      const { at, ...deps } = opts
      const handle = startUnconfirmedAccountSweeper({
        store: s.k.store,
        repos: s.k.repos,
        publisher: s.k.publisher,
        logger: s.k.logger,
        verification: s.k.services.auth.verification,
        intervalMs: HOUR_MS,
        ...deps,
        now: () => new Date(at.getTime()),
      })
      started.push(handle)
      return handle
    },
    stopAll(): void {
      for (const handle of started.splice(0)) handle.stop()
    },
  }
}
