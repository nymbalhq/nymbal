import { and, asc, eq, inArray } from 'drizzle-orm'
import type { OrderRefund, OrderRefundStatus } from '@nymbalhq/types'
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
import { fromTimestamp } from './json.js'

export interface OrderRefundInsert {
  id: string
  orderId: string
  amountMinor: number
  currency: string
  providerRefundId: string | null
  status: OrderRefundStatus
  reason: string | null
  actor: string
  createdAt: Date
}

function rowToRefund(row: Record<string, unknown>): OrderRefund {
  return {
    id: String(row.id),
    orderId: String(row.orderId),
    amountMinor: Number(row.amountMinor),
    currency: String(row.currency),
    providerRefundId: (row.providerRefundId as string | null) ?? null,
    status: row.status as OrderRefundStatus,
    reason: (row.reason as string | null) ?? null,
    actor: String(row.actor),
    createdAt: fromTimestamp(row.createdAt),
  }
}

export interface OrderRefundRepository extends StoreRepository {
  insert(tx: Tx, refund: OrderRefundInsert): Promise<void>
  /** Settles a `pending` refund; false when the row is not pending (already settled). */
  settle(
    tx: Tx,
    id: string,
    outcome: { status: OrderRefundStatus; providerRefundId: string | null },
  ): Promise<boolean>
  /** The order's refunds, oldest first. */
  listByOrder(tx: ReadTx, orderId: string): Promise<OrderRefund[]>
  /** The refunds of each order, oldest first; an order without refunds is absent. */
  listByOrders(tx: ReadTx, orderIds: string[]): Promise<Map<string, OrderRefund[]>>
}

export function createOrderRefundRepository(store: CommandStore): OrderRefundRepository {
  async function list(tx: ReadTx, orderIds: string[]): Promise<OrderRefund[]> {
    if (orderIds.length === 0) return []
    if (tx.kind === 'sqlite') {
      const r = sqliteSchema.orderRefunds
      const rows = sqliteDb(tx)
        .select()
        .from(r)
        .where(inArray(r.orderId, orderIds))
        .orderBy(asc(r.createdAt), asc(r.id))
        .all()
      return rows.map((row) => rowToRefund(row as Record<string, unknown>))
    }
    const r = postgresSchema.orderRefunds
    const rows = await postgresDb(tx)
      .select()
      .from(r)
      .where(inArray(r.orderId, orderIds))
      .orderBy(asc(r.createdAt), asc(r.id))
    return rows.map((row) => rowToRefund(row as Record<string, unknown>))
  }

  return {
    store,
    async insert(tx, refund) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.orderRefunds)
          .values({ ...refund, createdAt: refund.createdAt.toISOString() })
          .run()
        return
      }
      await postgresDb(tx).insert(postgresSchema.orderRefunds).values(refund)
    },
    async settle(tx, id, outcome) {
      if (tx.kind === 'sqlite') {
        const r = sqliteSchema.orderRefunds
        const { changes } = sqliteDb(tx)
          .update(r)
          .set(outcome)
          .where(and(eq(r.id, id), eq(r.status, 'pending')))
          .run()
        return changes > 0
      }
      const r = postgresSchema.orderRefunds
      const result = await postgresDb(tx)
        .update(r)
        .set(outcome)
        .where(and(eq(r.id, id), eq(r.status, 'pending')))
      return (result.rowCount ?? 0) > 0
    },
    listByOrder(tx, orderId) {
      return list(tx, [orderId])
    },
    async listByOrders(tx, orderIds) {
      const byOrder = new Map<string, OrderRefund[]>()
      for (const refund of await list(tx, orderIds)) {
        const refunds = byOrder.get(refund.orderId) ?? []
        refunds.push(refund)
        byOrder.set(refund.orderId, refunds)
      }
      return byOrder
    },
  }
}
