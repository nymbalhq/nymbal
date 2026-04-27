import { eq, sql } from 'drizzle-orm'
import type { Customer, CustomerAddress } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
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

function rowToCustomer(store: CommandStore['kind'], row: Record<string, unknown>): Customer & { passwordHash: string } {
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
    requiresPasswordReset: Boolean(row.requiresPasswordReset),
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

export type CustomerWithHash = Customer & { passwordHash: string }

export interface CustomerRepository {
  findById(id: string): Promise<CustomerWithHash | null>
  findByEmail(email: string): Promise<CustomerWithHash | null>
  list(opts?: { limit?: number; offset?: number }): Promise<CustomerWithHash[]>
  insert(c: CustomerInsert): Promise<void>
  update(id: string, patch: CustomerUpdate): Promise<void>
  incrementStats(id: string, deltaOrders: number, deltaSpentMinor: number, updatedAt: Date): Promise<void>
  delete(id: string): Promise<void>
}

export function createCustomerRepository(store: CommandStore): CustomerRepository {
  return {
    async findById(id) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.customers)
          .where(eq(sqliteSchema.customers.id, id))
          .get()
        return row ? rowToCustomer('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.customers)
        .where(eq(postgresSchema.customers.id, id))
      return row ? rowToCustomer('postgres', row as Record<string, unknown>) : null
    },
    async findByEmail(email) {
      const normalized = email.toLowerCase()
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.customers)
          .where(eq(sqliteSchema.customers.email, normalized))
          .get()
        return row ? rowToCustomer('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.customers)
        .where(eq(postgresSchema.customers.email, normalized))
      return row ? rowToCustomer('postgres', row as Record<string, unknown>) : null
    },
    async list(opts = {}) {
      const limit = opts.limit ?? 1000
      const offset = opts.offset ?? 0
      if (store.kind === 'sqlite') {
        const rows = store.db.select().from(sqliteSchema.customers).limit(limit).offset(offset).all()
        return rows.map((r) => rowToCustomer('sqlite', r as Record<string, unknown>))
      }
      const rows = await store.db.select().from(postgresSchema.customers).limit(limit).offset(offset)
      return rows.map((r) => rowToCustomer('postgres', r as Record<string, unknown>))
    },
    async insert(c) {
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
      if (store.kind === 'sqlite') {
        store.db
          .insert(sqliteSchema.customers)
          .values({
            ...common,
            addresses: JSON.stringify(c.addresses ?? []),
            metadata: JSON.stringify(c.metadata ?? {}),
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          })
          .run()
        return
      }
      await store.db.insert(postgresSchema.customers).values({
        ...common,
        addresses: c.addresses ?? [],
        metadata: c.metadata ?? {},
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })
    },
    async update(id, patch) {
      const pg: Record<string, unknown> = { updatedAt: patch.updatedAt }
      const sq: Record<string, unknown> = { updatedAt: patch.updatedAt.toISOString() }
      for (const k of ['firstName', 'lastName', 'phone', 'passwordHash', 'requiresPasswordReset'] as const) {
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
      if (store.kind === 'sqlite') {
        store.db
          .update(sqliteSchema.customers)
          .set(sq)
          .where(eq(sqliteSchema.customers.id, id))
          .run()
        return
      }
      await store.db
        .update(postgresSchema.customers)
        .set(pg)
        .where(eq(postgresSchema.customers.id, id))
    },
    async incrementStats(id, deltaOrders, deltaSpent, updatedAt) {
      if (store.kind === 'sqlite') {
        store.db
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
      await store.db
        .update(postgresSchema.customers)
        .set({
          orderCount: sql`${postgresSchema.customers.orderCount} + ${deltaOrders}`,
          totalSpentMinor: sql`${postgresSchema.customers.totalSpentMinor} + ${deltaSpent}`,
          updatedAt,
        })
        .where(eq(postgresSchema.customers.id, id))
    },
    async delete(id) {
      if (store.kind === 'sqlite') {
        store.db.delete(sqliteSchema.customers).where(eq(sqliteSchema.customers.id, id)).run()
        return
      }
      await store.db.delete(postgresSchema.customers).where(eq(postgresSchema.customers.id, id))
    },
  }
}
