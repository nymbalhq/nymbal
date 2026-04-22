import { asc, eq } from 'drizzle-orm'
import type { OrderHistoryEntry, OrderStatus } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { fromTimestamp } from './json.js'

export interface OrderHistoryInsert {
  id: string
  orderId: string
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  actor: string
  note?: string
  timestamp: Date
}

function rowToEntry(row: Record<string, unknown>): OrderHistoryEntry {
  return {
    id: String(row.id),
    orderId: String(row.orderId),
    fromStatus: (row.fromStatus as OrderStatus | null) ?? null,
    toStatus: row.toStatus as OrderStatus,
    actor: String(row.actor),
    note: String(row.note ?? ''),
    timestamp: fromTimestamp(row.timestamp),
  }
}

export interface OrderHistoryRepository {
  append(entry: OrderHistoryInsert): Promise<void>
  listByOrder(orderId: string): Promise<OrderHistoryEntry[]>
}

export function createOrderHistoryRepository(store: CommandStore): OrderHistoryRepository {
  return {
    async append(entry) {
      const common = {
        id: entry.id,
        orderId: entry.orderId,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actor: entry.actor,
        note: entry.note ?? '',
      }
      if (store.kind === 'sqlite') {
        store.db
          .insert(sqliteSchema.orderHistory)
          .values({ ...common, timestamp: entry.timestamp.toISOString() })
          .run()
        return
      }
      await store.db
        .insert(postgresSchema.orderHistory)
        .values({ ...common, timestamp: entry.timestamp })
    },
    async listByOrder(orderId) {
      if (store.kind === 'sqlite') {
        const rows = store.db
          .select()
          .from(sqliteSchema.orderHistory)
          .where(eq(sqliteSchema.orderHistory.orderId, orderId))
          .orderBy(asc(sqliteSchema.orderHistory.timestamp))
          .all()
        return rows.map((r) => rowToEntry(r as Record<string, unknown>))
      }
      const rows = await store.db
        .select()
        .from(postgresSchema.orderHistory)
        .where(eq(postgresSchema.orderHistory.orderId, orderId))
        .orderBy(asc(postgresSchema.orderHistory.timestamp))
      return rows.map((r) => rowToEntry(r as Record<string, unknown>))
    },
  }
}
