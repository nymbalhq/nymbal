import { and, desc, eq, notInArray } from 'drizzle-orm'
import type { Address, Order, OrderLineItem, OrderStatus } from '@nymbalhq/types'
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
  /** The cart a checkout order was placed from. */
  cartToken?: string | null
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

export interface OrderRepository extends StoreRepository {
  findById(tx: ReadTx, id: string): Promise<Order | null>
  findByOrderNumber(tx: ReadTx, orderNumber: string): Promise<Order | null>
  findByPaymentIntentId(tx: ReadTx, paymentIntentId: string): Promise<Order | null>
  /** The cart's pending order: at most one, by the partial unique index on `cart_token`. */
  findPendingByCartToken(tx: ReadTx, cartToken: string): Promise<Order | null>
  /** The newest order the cart became: neither pending nor cancelled. */
  findLastConvertedByCartToken(tx: ReadTx, cartToken: string): Promise<Order | null>
  listByCustomer(tx: ReadTx, customerId: string, limit?: number): Promise<Order[]>
  list(
    tx: ReadTx,
    opts?: { status?: OrderStatus; limit?: number; offset?: number },
  ): Promise<Order[]>
  insert(tx: Tx, o: OrderInsert): Promise<void>
  setStatus(tx: Tx, id: string, status: OrderStatus, updatedAt: Date): Promise<void>
  /** Sets `status` only while the order is still `from`; false when it was not, so a concurrent writer got there
   *  first. */
  setStatusIf(
    tx: Tx,
    id: string,
    from: OrderStatus,
    status: OrderStatus,
    updatedAt: Date,
  ): Promise<boolean>
  setPaymentIntent(tx: Tx, id: string, paymentIntentId: string, updatedAt: Date): Promise<void>
  setNotes(tx: Tx, id: string, notes: string, updatedAt: Date): Promise<void>
}

export function createOrderRepository(store: CommandStore): OrderRepository {
  return {
    store,
    async findById(tx, id) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.orders)
          .where(eq(sqliteSchema.orders.id, id))
          .get()
        return row ? rowToOrder('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.orders)
        .where(eq(postgresSchema.orders.id, id))
      return row ? rowToOrder('postgres', row as Record<string, unknown>) : null
    },
    async findByOrderNumber(tx, orderNumber) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.orders)
          .where(eq(sqliteSchema.orders.orderNumber, orderNumber))
          .get()
        return row ? rowToOrder('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.orders)
        .where(eq(postgresSchema.orders.orderNumber, orderNumber))
      return row ? rowToOrder('postgres', row as Record<string, unknown>) : null
    },
    async findByPaymentIntentId(tx, paymentIntentId) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.orders)
          .where(eq(sqliteSchema.orders.paymentIntentId, paymentIntentId))
          .get()
        return row ? rowToOrder('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.orders)
        .where(eq(postgresSchema.orders.paymentIntentId, paymentIntentId))
        .limit(1)
      return row ? rowToOrder('postgres', row as Record<string, unknown>) : null
    },
    async findPendingByCartToken(tx, cartToken) {
      if (tx.kind === 'sqlite') {
        const o = sqliteSchema.orders
        const row = sqliteDb(tx)
          .select()
          .from(o)
          .where(and(eq(o.cartToken, cartToken), eq(o.status, 'pending')))
          .get()
        return row ? rowToOrder('sqlite', row as Record<string, unknown>) : null
      }
      const o = postgresSchema.orders
      const [row] = await postgresDb(tx)
        .select()
        .from(o)
        .where(and(eq(o.cartToken, cartToken), eq(o.status, 'pending')))
      return row ? rowToOrder('postgres', row as Record<string, unknown>) : null
    },
    async findLastConvertedByCartToken(tx, cartToken) {
      const unconverted = ['pending', 'cancelled'] as const
      if (tx.kind === 'sqlite') {
        const o = sqliteSchema.orders
        const row = sqliteDb(tx)
          .select()
          .from(o)
          .where(and(eq(o.cartToken, cartToken), notInArray(o.status, [...unconverted])))
          .orderBy(desc(o.sequence))
          .limit(1)
          .get()
        return row ? rowToOrder('sqlite', row as Record<string, unknown>) : null
      }
      const o = postgresSchema.orders
      const [row] = await postgresDb(tx)
        .select()
        .from(o)
        .where(and(eq(o.cartToken, cartToken), notInArray(o.status, [...unconverted])))
        .orderBy(desc(o.sequence))
        .limit(1)
      return row ? rowToOrder('postgres', row as Record<string, unknown>) : null
    },
    async listByCustomer(tx, customerId, limit = 50) {
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx)
          .select()
          .from(sqliteSchema.orders)
          .where(eq(sqliteSchema.orders.customerId, customerId))
          .orderBy(desc(sqliteSchema.orders.createdAt))
          .limit(limit)
          .all()
        return rows.map((r) => rowToOrder('sqlite', r as Record<string, unknown>))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(postgresSchema.orders)
        .where(eq(postgresSchema.orders.customerId, customerId))
        .orderBy(desc(postgresSchema.orders.createdAt))
        .limit(limit)
      return rows.map((r) => rowToOrder('postgres', r as Record<string, unknown>))
    },
    async list(tx, opts = {}) {
      const limit = opts.limit ?? 100
      const offset = opts.offset ?? 0
      if (tx.kind === 'sqlite') {
        const base = sqliteDb(tx).select().from(sqliteSchema.orders)
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
      const base = postgresDb(tx).select().from(postgresSchema.orders)
      const filtered = opts.status
        ? base.where(eq(postgresSchema.orders.status, opts.status))
        : base
      const rows = await filtered
        .orderBy(desc(postgresSchema.orders.createdAt))
        .limit(limit)
        .offset(offset)
      return rows.map((r) => rowToOrder('postgres', r as Record<string, unknown>))
    },
    async insert(tx, o) {
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
        cartToken: o.cartToken ?? null,
      }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
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
      await postgresDb(tx)
        .insert(postgresSchema.orders)
        .values({
          ...common,
          billingAddress: o.billingAddress,
          shippingAddress: o.shippingAddress,
          lineItems: o.lineItems,
          metadata: o.metadata ?? {},
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })
    },
    async setStatus(tx, id, status, updatedAt) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.orders)
          .set({ status, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.orders.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.orders)
        .set({ status, updatedAt })
        .where(eq(postgresSchema.orders.id, id))
    },
    async setStatusIf(tx, id, from, status, updatedAt) {
      if (tx.kind === 'sqlite') {
        const o = sqliteSchema.orders
        const { changes } = sqliteDb(tx)
          .update(o)
          .set({ status, updatedAt: updatedAt.toISOString() })
          .where(and(eq(o.id, id), eq(o.status, from)))
          .run()
        return changes > 0
      }
      const o = postgresSchema.orders
      const result = await postgresDb(tx)
        .update(o)
        .set({ status, updatedAt })
        .where(and(eq(o.id, id), eq(o.status, from)))
      return (result.rowCount ?? 0) > 0
    },
    async setPaymentIntent(tx, id, paymentIntentId, updatedAt) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.orders)
          .set({ paymentIntentId, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.orders.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.orders)
        .set({ paymentIntentId, updatedAt })
        .where(eq(postgresSchema.orders.id, id))
    },
    async setNotes(tx, id, notes, updatedAt) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.orders)
          .set({ notes, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.orders.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.orders)
        .set({ notes, updatedAt })
        .where(eq(postgresSchema.orders.id, id))
    },
  }
}
