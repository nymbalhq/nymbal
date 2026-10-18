import { eq, sql } from 'drizzle-orm'
import type { Customer, CustomerAddress, Role } from '@nymbalhq/types'
import {
  postgresDb,
  sqliteDb,
  type CommandStore,
  type ReadTx,
  type StoreRepository,
  type Tx,
} from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { parseJson, fromTimestamp } from './json.js'

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
  updatedAt: Date
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
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

/** A stored customer: its roles column is always read. */
export type CustomerWithHash = Customer & { passwordHash: string; roles: Role[] }

export interface CustomerRepository extends StoreRepository {
  findById(tx: ReadTx, id: string): Promise<CustomerWithHash | null>
  findByEmail(tx: ReadTx, email: string): Promise<CustomerWithHash | null>
  list(tx: ReadTx, opts?: { limit?: number; offset?: number }): Promise<CustomerWithHash[]>
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
}

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
    async delete(tx, id) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx).delete(sqliteSchema.customers).where(eq(sqliteSchema.customers.id, id)).run()
        return
      }
      await postgresDb(tx)
        .delete(postgresSchema.customers)
        .where(eq(postgresSchema.customers.id, id))
    },
  }
}
