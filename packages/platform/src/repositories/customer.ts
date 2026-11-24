import { and, asc, eq, gt, gte, isNotNull, like, lt, notExists, or, sql, type SQL } from 'drizzle-orm'
import type { Customer, CustomerAddress, Role } from '@nymbalhq/types'
import {
  postgresDb,
  sqliteDb,
  type CommandStore,
  type PostgresClient,
  type SqliteClient,
  type ReadTx,
  type StoreRepository,
  type Tx,
} from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import type { KeysetPage } from './page.js'
import { parseJson, fromTimestamp } from './json.js'
import { IMPORTED_NO_PASSWORD, LEGACY_PASSWORD_PREFIX } from '../services/legacy-passwords.js'

export interface CustomerInsert {
  id: string
  email: string
  passwordHash: string
  firstName?: string
  lastName?: string
  phone?: string
  addresses?: CustomerAddress[]
  metadata?: Record<string, unknown>
  /** Defaults to `['customer']`; only seed and admin code pass anything else. */
  roles?: Role[]
  requiresPasswordReset?: boolean
  /** `'pending'` for a sign-up asked to confirm its address; absent leaves it null (never asked). */
  emailVerification?: 'pending'
  createdAt: Date
  updatedAt: Date
}

export interface CustomerUpdate {
  firstName?: string
  lastName?: string
  phone?: string
  addresses?: CustomerAddress[]
  metadata?: Record<string, unknown>
  passwordHash?: string
  requiresPasswordReset?: boolean
  /** A confirmation only ever moves a pending account to verified. */
  emailVerification?: 'verified'
  updatedAt: Date
}

/** Sign-ups asked to confirm their address in a window, and how many of them did. */
export interface VerificationFunnel {
  started: number
  verified: number
}

function rowToCustomer(
  store: CommandStore['kind'],
  row: Record<string, unknown>,
): CustomerWithHash {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.passwordHash),
    firstName: String(row.firstName ?? ''),
    lastName: String(row.lastName ?? ''),
    phone: String(row.phone ?? ''),
    addresses: parseJson<CustomerAddress[]>(store, row.addresses, []),
    orderCount: Number(row.orderCount ?? 0),
    totalSpentMinor: Number(row.totalSpentMinor ?? 0),
    metadata: parseJson<Record<string, unknown>>(store, row.metadata, {}),
    roles: parseJson<Role[]>(store, row.roles, ['customer']),
    requiresPasswordReset: Boolean(row.requiresPasswordReset),
    ...((row.emailVerification === 'pending' || row.emailVerification === 'verified') && {
      emailVerification: row.emailVerification,
    }),
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

/** The window an unconfirmed account is judged in: last written before `before`, links compared with `now`. */
export interface UnconfirmedWindow {
  before: Date
  now: Date
}

// An account never confirmed, last written before `before`, with no order and no verification or reset link still open
// at `now`. The list and the conditional delete read this one predicate, so a delete re-checks all of it.
function sqliteUnconfirmedDue(db: SqliteClient, w: UnconfirmedWindow): SQL {
  const { customers: c, orders, emailVerificationTokens, passwordResetTokens } = sqliteSchema
  const now = w.now.toISOString()
  const one = { one: sql`1` }
  return and(
    eq(c.emailVerification, 'pending'),
    lt(c.updatedAt, w.before.toISOString()),
    notExists(db.select(one).from(orders).where(eq(orders.customerId, c.id))),
    ...[emailVerificationTokens, passwordResetTokens].map((t) =>
      notExists(db.select(one).from(t).where(and(eq(t.customerId, c.id), gt(t.expiresAt, now)))),
    ),
  )!
}

function postgresUnconfirmedDue(db: PostgresClient, w: UnconfirmedWindow): SQL {
  const { customers: c, orders, emailVerificationTokens, passwordResetTokens } = postgresSchema
  const one = { one: sql`1` }
  return and(
    eq(c.emailVerification, 'pending'),
    lt(c.updatedAt, w.before),
    notExists(db.select(one).from(orders).where(eq(orders.customerId, c.id))),
    ...[emailVerificationTokens, passwordResetTokens].map((t) =>
      notExists(db.select(one).from(t).where(and(eq(t.customerId, c.id), gt(t.expiresAt, w.now)))),
    ),
  )!
}

// An account with the customer role whose email, first name or last name holds `q`, ignoring case: instr and strpos
// compare characters, so a % or _ matches only itself. SQLite's own lower() folds ASCII alone, so that side goes
// through the store connection's unicode_lower.
function sqliteSearchMatch(q: string): SQL {
  const c = sqliteSchema.customers
  const holds = (column: SQL) =>
    sql`instr(unicode_lower(${column}), unicode_lower(cast(${q} as text))) > 0`
  return and(
    sql`exists (select 1 from json_each(${c.roles}) where value = 'customer')`,
    or(holds(sql`${c.email}`), holds(sql`${c.firstName}`), holds(sql`${c.lastName}`)),
  )!
}

function postgresSearchMatch(q: string): SQL {
  const c = postgresSchema.customers
  const holds = (column: SQL) => sql`strpos(lower(${column}), lower(cast(${q} as text))) > 0`
  return and(
    sql`${c.roles} @> jsonb_build_array('customer'::text)`,
    or(holds(sql`${c.email}`), holds(sql`${c.firstName}`), holds(sql`${c.lastName}`)),
  )!
}

/** A stored customer: its roles column is always read. */
export type CustomerWithHash = Customer & { passwordHash: string; roles: Role[] }

export interface CustomerRepository extends StoreRepository {
  findById(tx: ReadTx, id: string): Promise<CustomerWithHash | null>
  findByEmail(tx: ReadTx, email: string): Promise<CustomerWithHash | null>
  list(tx: ReadTx, opts?: { limit?: number; offset?: number }): Promise<CustomerWithHash[]>
  /**
   * Accounts with the customer role whose email, first name or last name holds `q`, case-insensitive, every character
   * literal; createdAt ascending, then id, at most `limit`.
   */
  search(tx: ReadTx, opts: { q: string; limit: number }): Promise<CustomerWithHash[]>
  /** Rows by id after `page.after`: a walk over the table that a concurrent write cannot make skip a row. */
  listPage(tx: ReadTx, page: KeysetPage): Promise<CustomerWithHash[]>
  insert(tx: Tx, c: CustomerInsert): Promise<void>
  update(tx: Tx, id: string, patch: CustomerUpdate): Promise<void>
  incrementStats(
    tx: Tx,
    id: string,
    deltaOrders: number,
    deltaSpentMinor: number,
    updatedAt: Date,
  ): Promise<void>
  delete(tx: Tx, id: string): Promise<void>
  /** Ids of accounts due for removal as never confirmed, after `after`, ascending, at most `limit`. */
  listUnconfirmed(
    tx: ReadTx,
    opts: UnconfirmedWindow & { after?: string; limit: number },
  ): Promise<string[]>
  /** Deletes the row only while it is still due; true when it went. Its credential rows are the caller's. */
  deleteUnconfirmed(tx: Tx, id: string, window: UnconfirmedWindow): Promise<boolean>
  /** Accounts created in `since <= created_at < until` that were asked to confirm, and of those the confirmed. */
  verificationFunnel(tx: ReadTx, since: Date, until: Date): Promise<VerificationFunnel>
  /** Writes `passwordHash` only where the row still holds `from`; whether it did. */
  replacePasswordHash(tx: Tx, id: string, change: PasswordHashChange): Promise<boolean>
  /** Every row holding an imported legacy hash gets the no-password marker; the rows it changed, as they are now. */
  sunsetLegacyPasswords(tx: Tx, updatedAt: Date): Promise<CustomerWithHash[]>
  countLegacyPasswords(tx: ReadTx): Promise<number>
}

export interface PasswordHashChange {
  from: string
  passwordHash: string
  requiresPasswordReset: boolean
}

const LEGACY_LIKE = `${LEGACY_PASSWORD_PREFIX}%`

export function createCustomerRepository(store: CommandStore): CustomerRepository {
  return {
    store,
    async findById(tx, id) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.customers)
          .where(eq(sqliteSchema.customers.id, id))
          .get()
        return row ? rowToCustomer('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.customers)
        .where(eq(postgresSchema.customers.id, id))
      return row ? rowToCustomer('postgres', row as Record<string, unknown>) : null
    },
    async findByEmail(tx, email) {
      const normalized = email.toLowerCase()
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.customers)
          .where(eq(sqliteSchema.customers.email, normalized))
          .get()
        return row ? rowToCustomer('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.customers)
        .where(eq(postgresSchema.customers.email, normalized))
      return row ? rowToCustomer('postgres', row as Record<string, unknown>) : null
    },
    async listPage(tx, page) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.customers
        const rows = sqliteDb(tx)
          .select()
          .from(t)
          .where(page.after === undefined ? undefined : gt(t.id, page.after))
          .orderBy(asc(t.id))
          .limit(page.limit)
          .all()
        return rows.map((r) => rowToCustomer('sqlite', r as Record<string, unknown>))
      }
      const t = postgresSchema.customers
      const rows = await postgresDb(tx)
        .select()
        .from(t)
        .where(page.after === undefined ? undefined : gt(t.id, page.after))
        .orderBy(asc(t.id))
        .limit(page.limit)
      return rows.map((r) => rowToCustomer('postgres', r as Record<string, unknown>))
    },
    async list(tx, opts = {}) {
      const limit = opts.limit ?? 1000
      const offset = opts.offset ?? 0
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx)
          .select()
          .from(sqliteSchema.customers)
          .limit(limit)
          .offset(offset)
          .all()
        return rows.map((r) => rowToCustomer('sqlite', r as Record<string, unknown>))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(postgresSchema.customers)
        .limit(limit)
        .offset(offset)
      return rows.map((r) => rowToCustomer('postgres', r as Record<string, unknown>))
    },
    async search(tx, { q, limit }) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.customers
        const rows = sqliteDb(tx)
          .select()
          .from(t)
          .where(sqliteSearchMatch(q))
          .orderBy(asc(t.createdAt), asc(t.id))
          .limit(limit)
          .all()
        return rows.map((r) => rowToCustomer('sqlite', r as Record<string, unknown>))
      }
      const t = postgresSchema.customers
      const rows = await postgresDb(tx)
        .select()
        .from(t)
        .where(postgresSearchMatch(q))
        .orderBy(asc(t.createdAt), asc(t.id))
        .limit(limit)
      return rows.map((r) => rowToCustomer('postgres', r as Record<string, unknown>))
    },
    async insert(tx, c) {
      const email = c.email.toLowerCase()
      const common = {
        id: c.id,
        email,
        passwordHash: c.passwordHash,
        firstName: c.firstName ?? '',
        lastName: c.lastName ?? '',
        phone: c.phone ?? '',
        orderCount: 0,
        totalSpentMinor: 0,
        requiresPasswordReset: c.requiresPasswordReset ?? false,
        emailVerification: c.emailVerification ?? null,
      }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.customers)
          .values({
            ...common,
            addresses: JSON.stringify(c.addresses ?? []),
            metadata: JSON.stringify(c.metadata ?? {}),
            roles: JSON.stringify(c.roles ?? ['customer']),
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.customers)
        .values({
          ...common,
          addresses: c.addresses ?? [],
          metadata: c.metadata ?? {},
          roles: c.roles ?? ['customer'],
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })
    },
    async update(tx, id, patch) {
      const pg: Record<string, unknown> = { updatedAt: patch.updatedAt }
      const sq: Record<string, unknown> = { updatedAt: patch.updatedAt.toISOString() }
      for (const k of [
        'firstName',
        'lastName',
        'phone',
        'passwordHash',
        'requiresPasswordReset',
        'emailVerification',
      ] as const) {
        if (patch[k] !== undefined) {
          pg[k] = patch[k]
          sq[k] = patch[k]
        }
      }
      if (patch.addresses !== undefined) {
        pg.addresses = patch.addresses
        sq.addresses = JSON.stringify(patch.addresses)
      }
      if (patch.metadata !== undefined) {
        pg.metadata = patch.metadata
        sq.metadata = JSON.stringify(patch.metadata)
      }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.customers)
          .set(sq)
          .where(eq(sqliteSchema.customers.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.customers)
        .set(pg)
        .where(eq(postgresSchema.customers.id, id))
    },
    async incrementStats(tx, id, deltaOrders, deltaSpent, updatedAt) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.customers)
          .set({
            orderCount: sql`${sqliteSchema.customers.orderCount} + ${deltaOrders}`,
            totalSpentMinor: sql`${sqliteSchema.customers.totalSpentMinor} + ${deltaSpent}`,
            updatedAt: updatedAt.toISOString(),
          })
          .where(eq(sqliteSchema.customers.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.customers)
        .set({
          orderCount: sql`${postgresSchema.customers.orderCount} + ${deltaOrders}`,
          totalSpentMinor: sql`${postgresSchema.customers.totalSpentMinor} + ${deltaSpent}`,
          updatedAt,
        })
        .where(eq(postgresSchema.customers.id, id))
    },
    async verificationFunnel(tx, since, until) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.customers
        const row = sqliteDb(tx)
          .select({
            started: sql<number>`count(*)`,
            verified: sql<number>`count(*) filter (where ${t.emailVerification} = 'verified')`,
          })
          .from(t)
          .where(
            and(
              gte(t.createdAt, since.toISOString()),
              lt(t.createdAt, until.toISOString()),
              isNotNull(t.emailVerification),
            ),
          )
          .get()
        return { started: Number(row?.started ?? 0), verified: Number(row?.verified ?? 0) }
      }
      const t = postgresSchema.customers
      const [row] = await postgresDb(tx)
        .select({
          started: sql<number>`count(*)`,
          verified: sql<number>`count(*) filter (where ${t.emailVerification} = 'verified')`,
        })
        .from(t)
        .where(and(gte(t.createdAt, since), lt(t.createdAt, until), isNotNull(t.emailVerification)))
      return { started: Number(row?.started ?? 0), verified: Number(row?.verified ?? 0) }
    },
    async listUnconfirmed(tx, opts) {
      const { after, limit } = opts
      if (tx.kind === 'sqlite') {
        const db = sqliteDb(tx)
        const t = sqliteSchema.customers
        const rows = db
          .select({ id: t.id })
          .from(t)
          .where(
            and(sqliteUnconfirmedDue(db, opts), after === undefined ? undefined : gt(t.id, after)),
          )
          .orderBy(asc(t.id))
          .limit(limit)
          .all()
        return rows.map((r) => r.id)
      }
      const db = postgresDb(tx)
      const t = postgresSchema.customers
      const rows = await db
        .select({ id: t.id })
        .from(t)
        .where(
          and(postgresUnconfirmedDue(db, opts), after === undefined ? undefined : gt(t.id, after)),
        )
        .orderBy(asc(t.id))
        .limit(limit)
      return rows.map((r) => r.id)
    },
    async deleteUnconfirmed(tx, id, window) {
      if (tx.kind === 'sqlite') {
        const db = sqliteDb(tx)
        const t = sqliteSchema.customers
        const result = db
          .delete(t)
          .where(and(eq(t.id, id), sqliteUnconfirmedDue(db, window)))
          .run()
        return result.changes > 0
      }
      const db = postgresDb(tx)
      const t = postgresSchema.customers
      const rows = await db
        .delete(t)
        .where(and(eq(t.id, id), postgresUnconfirmedDue(db, window)))
        .returning({ id: t.id })
      return rows.length > 0
    },
    async delete(tx, id) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx).delete(sqliteSchema.customers).where(eq(sqliteSchema.customers.id, id)).run()
        return
      }
      await postgresDb(tx)
        .delete(postgresSchema.customers)
        .where(eq(postgresSchema.customers.id, id))
    },
    async replacePasswordHash(tx, id, change) {
      const set = {
        passwordHash: change.passwordHash,
        requiresPasswordReset: change.requiresPasswordReset,
      }
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.customers
        const result = sqliteDb(tx)
          .update(t)
          .set({ ...set, updatedAt: new Date().toISOString() })
          .where(and(eq(t.id, id), eq(t.passwordHash, change.from)))
          .run()
        return result.changes === 1
      }
      const t = postgresSchema.customers
      const result = await postgresDb(tx)
        .update(t)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(t.id, id), eq(t.passwordHash, change.from)))
      return result.rowCount === 1
    },
    async sunsetLegacyPasswords(tx, updatedAt) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.customers
        return sqliteDb(tx)
          .update(t)
          .set({ passwordHash: IMPORTED_NO_PASSWORD, updatedAt: updatedAt.toISOString() })
          .where(like(t.passwordHash, LEGACY_LIKE))
          .returning()
          .all()
          .map((r) => rowToCustomer('sqlite', r as Record<string, unknown>))
      }
      const t = postgresSchema.customers
      const rows = await postgresDb(tx)
        .update(t)
        .set({ passwordHash: IMPORTED_NO_PASSWORD, updatedAt })
        .where(like(t.passwordHash, LEGACY_LIKE))
        .returning()
      return rows.map((r) => rowToCustomer('postgres', r as Record<string, unknown>))
    },
    async countLegacyPasswords(tx) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.customers
        const row = sqliteDb(tx)
          .select({ n: sql<number>`count(*)` })
          .from(t)
          .where(like(t.passwordHash, LEGACY_LIKE))
          .get()
        return Number(row?.n ?? 0)
      }
      const t = postgresSchema.customers
      const [row] = await postgresDb(tx)
        .select({ n: sql<number>`count(*)` })
        .from(t)
        .where(like(t.passwordHash, LEGACY_LIKE))
      return Number(row?.n ?? 0)
    },
  }
}
