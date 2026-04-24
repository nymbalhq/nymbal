import { desc, eq } from 'drizzle-orm'
import type { Address, Order, OrderLineItem, OrderStatus } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { parseJson, fromTimestamp } from './json.js'

export interface OrderInsert {
  id: string
  orderNumber: string
  sequence: number
  customerId: string | null
  status: OrderStatus
  email: string
  billingAddress: Address
  shippingAddress: Address
  lineItems: OrderLineItem[]
  subtotalMinor: number
  taxTotalMinor: number
  shippingTotalMinor: number
  discountTotalMinor: number
  totalMinor: number
  currency: string
  notes?: string
  metadata?: Record<string, unknown>
  paymentIntentId?: string | null
  createdAt: Date
  updatedAt: Date
}

function rowToOrder(store: CommandStore['kind'], row: Record<string, unknown>): Order {
  return {
    id: String(row.id),
    orderNumber: String(row.orderNumber),
    sequence: Number(row.sequence),
    customerId: (row.customerId as string | null) ?? null,
    status: row.status as OrderStatus,
    email: String(row.email),
    billingAddress: parseJson<Address>(store, row.billingAddress, {} as Address),
    shippingAddress: parseJson<Address>(store, row.shippingAddress, {} as Address),
    lineItems: parseJson<OrderLineItem[]>(store, row.lineItems, []),
    subtotalMinor: Number(row.subtotalMinor),
    taxTotalMinor: Number(row.taxTotalMinor ?? 0),
    shippingTotalMinor: Number(row.shippingTotalMinor ?? 0),
    discountTotalMinor: Number(row.discountTotalMinor ?? 0),
    totalMinor: Number(row.totalMinor),
    currency: String(row.currency),
    notes: String(row.notes ?? ''),
    metadata: parseJson<Record<string, unknown>>(store, row.metadata, {}),
    paymentIntentId: (row.paymentIntentId as string | null) ?? null,
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

export interface OrderRepository {
  findById(id: string): Promise<Order | null>
  findByOrderNumber(orderNumber: string): Promise<Order | null>
  listByCustomer(customerId: string, limit?: number): Promise<Order[]>
  list(opts?: { status?: OrderStatus; limit?: number; offset?: number }): Promise<Order[]>
  insert(o: OrderInsert): Promise<void>
  setStatus(id: string, status: OrderStatus, updatedAt: Date): Promise<void>
  setPaymentIntent(id: string, paymentIntentId: string, updatedAt: Date): Promise<void>
  setNotes(id: string, notes: string, updatedAt: Date): Promise<void>
}

export function createOrderRepository(store: CommandStore): OrderRepository {
  return {
    async findById(id) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.orders)
          .where(eq(sqliteSchema.orders.id, id))
          .get()
        return row ? rowToOrder('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.orders)
        .where(eq(postgresSchema.orders.id, id))
      return row ? rowToOrder('postgres', row as Record<string, unknown>) : null
    },
    async findByOrderNumber(orderNumber) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.orders)
          .where(eq(sqliteSchema.orders.orderNumber, orderNumber))
          .get()
        return row ? rowToOrder('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.orders)
        .where(eq(postgresSchema.orders.orderNumber, orderNumber))
      return row ? rowToOrder('postgres', row as Record<string, unknown>) : null
    },
    async listByCustomer(customerId, limit = 50) {
      if (store.kind === 'sqlite') {
        const rows = store.db
          .select()
          .from(sqliteSchema.orders)
          .where(eq(sqliteSchema.orders.customerId, customerId))
          .orderBy(desc(sqliteSchema.orders.createdAt))
          .limit(limit)
          .all()
        return rows.map((r) => rowToOrder('sqlite', r as Record<string, unknown>))
      }
      const rows = await store.db
        .select()
        .from(postgresSchema.orders)
        .where(eq(postgresSchema.orders.customerId, customerId))
        .orderBy(desc(postgresSchema.orders.createdAt))
        .limit(limit)
      return rows.map((r) => rowToOrder('postgres', r as Record<string, unknown>))
    },
    async list(opts = {}) {
      const limit = opts.limit ?? 100
      const offset = opts.offset ?? 0
      if (store.kind === 'sqlite') {
        const base = store.db.select().from(sqliteSchema.orders)
        const filtered = opts.status
          ? base.where(eq(sqliteSchema.orders.status, opts.status))
          : base
        const rows = filtered
          .orderBy(desc(sqliteSchema.orders.createdAt))
          .limit(limit)
          .offset(offset)
          .all()
        return rows.map((r) => rowToOrder('sqlite', r as Record<string, unknown>))
      }
      const base = store.db.select().from(postgresSchema.orders)
      const filtered = opts.status
        ? base.where(eq(postgresSchema.orders.status, opts.status))
        : base
      const rows = await filtered
        .orderBy(desc(postgresSchema.orders.createdAt))
        .limit(limit)
        .offset(offset)
      return rows.map((r) => rowToOrder('postgres', r as Record<string, unknown>))
    },
    async insert(o) {
      const common = {
        id: o.id,
        orderNumber: o.orderNumber,
        sequence: o.sequence,
        customerId: o.customerId,
        status: o.status,
        email: o.email,
        subtotalMinor: o.subtotalMinor,
        taxTotalMinor: o.taxTotalMinor,
        shippingTotalMinor: o.shippingTotalMinor,
        discountTotalMinor: o.discountTotalMinor,
        totalMinor: o.totalMinor,
        currency: o.currency,
        notes: o.notes ?? '',
        paymentIntentId: o.paymentIntentId ?? null,
      }
      if (store.kind === 'sqlite') {
        store.db
          .insert(sqliteSchema.orders)
          .values({
            ...common,
            billingAddress: JSON.stringify(o.billingAddress),
            shippingAddress: JSON.stringify(o.shippingAddress),
            lineItems: JSON.stringify(o.lineItems),
            metadata: JSON.stringify(o.metadata ?? {}),
            createdAt: o.createdAt.toISOString(),
            updatedAt: o.updatedAt.toISOString(),
          })
          .run()
        return
      }
      await store.db.insert(postgresSchema.orders).values({
        ...common,
        billingAddress: o.billingAddress,
        shippingAddress: o.shippingAddress,
        lineItems: o.lineItems,
        metadata: o.metadata ?? {},
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      })
    },
    async setStatus(id, status, updatedAt) {
      if (store.kind === 'sqlite') {
        store.db
          .update(sqliteSchema.orders)
          .set({ status, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.orders.id, id))
          .run()
        return
      }
      await store.db
        .update(postgresSchema.orders)
        .set({ status, updatedAt })
        .where(eq(postgresSchema.orders.id, id))
    },
    async setPaymentIntent(id, paymentIntentId, updatedAt) {
      if (store.kind === 'sqlite') {
        store.db
          .update(sqliteSchema.orders)
          .set({ paymentIntentId, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.orders.id, id))
          .run()
        return
      }
      await store.db
        .update(postgresSchema.orders)
        .set({ paymentIntentId, updatedAt })
        .where(eq(postgresSchema.orders.id, id))
    },
    async setNotes(id, notes, updatedAt) {
      if (store.kind === 'sqlite') {
        store.db
          .update(sqliteSchema.orders)
          .set({ notes, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.orders.id, id))
          .run()
        return
      }
      await store.db
        .update(postgresSchema.orders)
        .set({ notes, updatedAt })
        .where(eq(postgresSchema.orders.id, id))
    },
  }
}
