import { and, eq, gte, sql } from 'drizzle-orm'
import type { Variant, VariantOption, VariantStatus, VariantDimensions } from '@nymbalhq/types'
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

export interface VariantInsert {
  id: string
  productId: string
  sku: string
  name: string
  priceMinor: number
  compareAtPriceMinor?: number | null
  weightGrams?: number | null
  dimensions?: VariantDimensions | null
  stock: number
  lowStockThreshold?: number
  options: VariantOption[]
  status?: VariantStatus
  createdAt: Date
  updatedAt: Date
}

export interface VariantUpdate {
  name?: string
  priceMinor?: number
  compareAtPriceMinor?: number | null
  weightGrams?: number | null
  dimensions?: VariantDimensions | null
  lowStockThreshold?: number
  options?: VariantOption[]
  status?: VariantStatus
  updatedAt: Date
}

function rowToVariant(store: CommandStore['kind'], row: Record<string, unknown>): Variant {
  return {
    id: String(row.id),
    productId: String(row.productId),
    sku: String(row.sku),
    name: String(row.name ?? ''),
    priceMinor: Number(row.priceMinor),
    compareAtPriceMinor: row.compareAtPriceMinor == null ? null : Number(row.compareAtPriceMinor),
    weightGrams: row.weightGrams == null ? null : Number(row.weightGrams),
    dimensions: parseJson<VariantDimensions | null>(store, row.dimensions, null),
    stock: Number(row.stock),
    lowStockThreshold: Number(row.lowStockThreshold ?? 0),
    options: parseJson<VariantOption[]>(store, row.options, []),
    status: row.status as VariantStatus,
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

export interface VariantRepository extends StoreRepository {
  findById(tx: ReadTx, id: string): Promise<Variant | null>
  findBySku(tx: ReadTx, sku: string): Promise<Variant | null>
  findByProduct(tx: ReadTx, productId: string): Promise<Variant[]>
  insert(tx: Tx, v: VariantInsert): Promise<void>
  update(tx: Tx, id: string, patch: VariantUpdate): Promise<void>
  /** One conditional UPDATE: the new stock, or null when the variant is missing or holds fewer than `qty`. */
  decrementStock(tx: Tx, id: string, qty: number, at: Date): Promise<number | null>
  /** The new stock, or null when there is no such variant. */
  incrementStock(tx: Tx, id: string, qty: number, at: Date): Promise<number | null>
  delete(tx: Tx, id: string): Promise<void>
}

export function createVariantRepository(store: CommandStore): VariantRepository {
  return {
    store,
    async findById(tx, id) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.variants)
          .where(eq(sqliteSchema.variants.id, id))
          .get()
        return row ? rowToVariant('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.variants)
        .where(eq(postgresSchema.variants.id, id))
      return row ? rowToVariant('postgres', row as Record<string, unknown>) : null
    },
    async findBySku(tx, sku) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.variants)
          .where(eq(sqliteSchema.variants.sku, sku))
          .get()
        return row ? rowToVariant('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.variants)
        .where(eq(postgresSchema.variants.sku, sku))
      return row ? rowToVariant('postgres', row as Record<string, unknown>) : null
    },
    async findByProduct(tx, productId) {
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx)
          .select()
          .from(sqliteSchema.variants)
          .where(eq(sqliteSchema.variants.productId, productId))
          .all()
        return rows.map((r) => rowToVariant('sqlite', r as Record<string, unknown>))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(postgresSchema.variants)
        .where(eq(postgresSchema.variants.productId, productId))
      return rows.map((r) => rowToVariant('postgres', r as Record<string, unknown>))
    },
    async insert(tx, v) {
      const common = {
        id: v.id,
        productId: v.productId,
        sku: v.sku,
        name: v.name,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor ?? null,
        weightGrams: v.weightGrams ?? null,
        stock: v.stock,
        lowStockThreshold: v.lowStockThreshold ?? 0,
        status: v.status ?? 'active',
      }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.variants)
          .values({
            ...common,
            dimensions: v.dimensions ? JSON.stringify(v.dimensions) : null,
            options: JSON.stringify(v.options),
            createdAt: v.createdAt.toISOString(),
            updatedAt: v.updatedAt.toISOString(),
          })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.variants)
        .values({
          ...common,
          dimensions: v.dimensions ?? null,
          options: v.options,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        })
    },
    async update(tx, id, patch) {
      const pg: Record<string, unknown> = { updatedAt: patch.updatedAt }
      const sq: Record<string, unknown> = { updatedAt: patch.updatedAt.toISOString() }
      for (const k of [
        'name',
        'priceMinor',
        'compareAtPriceMinor',
        'weightGrams',
        'lowStockThreshold',
        'status',
      ] as const) {
        if (patch[k] !== undefined) {
          pg[k] = patch[k]
          sq[k] = patch[k]
        }
      }
      if (patch.dimensions !== undefined) {
        pg.dimensions = patch.dimensions ?? null
        sq.dimensions = patch.dimensions ? JSON.stringify(patch.dimensions) : null
      }
      if (patch.options !== undefined) {
        pg.options = patch.options
        sq.options = JSON.stringify(patch.options)
      }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.variants)
          .set(sq)
          .where(eq(sqliteSchema.variants.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.variants)
        .set(pg)
        .where(eq(postgresSchema.variants.id, id))
    },
    async decrementStock(tx, id, qty, at) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .update(sqliteSchema.variants)
          .set({ stock: sql`${sqliteSchema.variants.stock} - ${qty}`, updatedAt: at.toISOString() })
          .where(and(eq(sqliteSchema.variants.id, id), gte(sqliteSchema.variants.stock, qty)))
          .returning({ stock: sqliteSchema.variants.stock })
          .get()
        return row ? Number(row.stock) : null
      }
      const [row] = await postgresDb(tx)
        .update(postgresSchema.variants)
        .set({ stock: sql`${postgresSchema.variants.stock} - ${qty}`, updatedAt: at })
        .where(and(eq(postgresSchema.variants.id, id), gte(postgresSchema.variants.stock, qty)))
        .returning({ stock: postgresSchema.variants.stock })
      return row ? Number(row.stock) : null
    },
    async incrementStock(tx, id, qty, at) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .update(sqliteSchema.variants)
          .set({ stock: sql`${sqliteSchema.variants.stock} + ${qty}`, updatedAt: at.toISOString() })
          .where(eq(sqliteSchema.variants.id, id))
          .returning({ stock: sqliteSchema.variants.stock })
          .get()
        return row ? Number(row.stock) : null
      }
      const [row] = await postgresDb(tx)
        .update(postgresSchema.variants)
        .set({ stock: sql`${postgresSchema.variants.stock} + ${qty}`, updatedAt: at })
        .where(eq(postgresSchema.variants.id, id))
        .returning({ stock: postgresSchema.variants.stock })
      return row ? Number(row.stock) : null
    },
    async delete(tx, id) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx).delete(sqliteSchema.variants).where(eq(sqliteSchema.variants.id, id)).run()
        return
      }
      await postgresDb(tx).delete(postgresSchema.variants).where(eq(postgresSchema.variants.id, id))
    },
  }
}
