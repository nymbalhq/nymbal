import { desc, eq } from 'drizzle-orm'
import type { StockAdjustment, StockAdjustmentReason } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { fromTimestamp } from './json.js'

export interface StockAdjustmentInsert {
  id: string
  variantId: string
  adjustment: number
  reason: StockAdjustmentReason
  actor: string
  previousQty: number
  newQty: number
  timestamp: Date
}

function rowToAdjustment(row: Record<string, unknown>): StockAdjustment {
  return {
    id: String(row.id),
    variantId: String(row.variantId),
    adjustment: Number(row.adjustment),
    reason: row.reason as StockAdjustmentReason,
    actor: String(row.actor),
    previousQty: Number(row.previousQty),
    newQty: Number(row.newQty),
    timestamp: fromTimestamp(row.timestamp),
  }
}

export interface StockAdjustmentRepository {
  append(a: StockAdjustmentInsert): Promise<void>
  listByVariant(variantId: string, limit?: number): Promise<StockAdjustment[]>
}

export function createStockAdjustmentRepository(store: CommandStore): StockAdjustmentRepository {
  return {
    async append(a) {
      const common = {
        id: a.id,
        variantId: a.variantId,
        adjustment: a.adjustment,
        reason: a.reason,
        actor: a.actor,
        previousQty: a.previousQty,
        newQty: a.newQty,
      }
      if (store.kind === 'sqlite') {
        store.db
          .insert(sqliteSchema.stockAdjustments)
          .values({ ...common, timestamp: a.timestamp.toISOString() })
          .run()
        return
      }
      await store.db
        .insert(postgresSchema.stockAdjustments)
        .values({ ...common, timestamp: a.timestamp })
    },
    async listByVariant(variantId, limit = 100) {
      if (store.kind === 'sqlite') {
        const rows = store.db
          .select()
          .from(sqliteSchema.stockAdjustments)
          .where(eq(sqliteSchema.stockAdjustments.variantId, variantId))
          .orderBy(desc(sqliteSchema.stockAdjustments.timestamp))
          .limit(limit)
          .all()
        return rows.map((r) => rowToAdjustment(r as Record<string, unknown>))
      }
      const rows = await store.db
        .select()
        .from(postgresSchema.stockAdjustments)
        .where(eq(postgresSchema.stockAdjustments.variantId, variantId))
        .orderBy(desc(postgresSchema.stockAdjustments.timestamp))
        .limit(limit)
      return rows.map((r) => rowToAdjustment(r as Record<string, unknown>))
    },
  }
}
