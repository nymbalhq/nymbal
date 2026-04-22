import { eq } from 'drizzle-orm'
import type { Variant, VariantOption, VariantStatus, VariantDimensions } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
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

export interface VariantRepository {
  findById(id: string): Promise<Variant | null>
  findBySku(sku: string): Promise<Variant | null>
  findByProduct(productId: string): Promise<Variant[]>
  insert(v: VariantInsert): Promise<void>
  update(id: string, patch: VariantUpdate): Promise<void>
  setStock(id: string, newStock: number, updatedAt: Date): Promise<void>
  delete(id: string): Promise<void>
}

export function createVariantRepository(store: CommandStore): VariantRepository {
  return {
    async findById(id) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.variants)
          .where(eq(sqliteSchema.variants.id, id))
          .get()
        return row ? rowToVariant('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.variants)
        .where(eq(postgresSchema.variants.id, id))
      return row ? rowToVariant('postgres', row as Record<string, unknown>) : null
    },
    async findBySku(sku) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.variants)
          .where(eq(sqliteSchema.variants.sku, sku))
          .get()
        return row ? rowToVariant('sqlite', row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.variants)
        .where(eq(postgresSchema.variants.sku, sku))
      return row ? rowToVariant('postgres', row as Record<string, unknown>) : null
    },
    async findByProduct(productId) {
      if (store.kind === 'sqlite') {
        const rows = store.db
          .select()
          .from(sqliteSchema.variants)
          .where(eq(sqliteSchema.variants.productId, productId))
          .all()
        return rows.map((r) => rowToVariant('sqlite', r as Record<string, unknown>))
      }
      const rows = await store.db
        .select()
        .from(postgresSchema.variants)
        .where(eq(postgresSchema.variants.productId, productId))
      return rows.map((r) => rowToVariant('postgres', r as Record<string, unknown>))
    },
    async insert(v) {
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
      if (store.kind === 'sqlite') {
        store.db
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
      await store.db.insert(postgresSchema.variants).values({
        ...common,
        dimensions: v.dimensions ?? null,
        options: v.options,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })
    },
    async update(id, patch) {
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
      if (store.kind === 'sqlite') {
        store.db.update(sqliteSchema.variants).set(sq).where(eq(sqliteSchema.variants.id, id)).run()
        return
      }
      await store.db
        .update(postgresSchema.variants)
        .set(pg)
        .where(eq(postgresSchema.variants.id, id))
    },
    async setStock(id, newStock, updatedAt) {
      if (store.kind === 'sqlite') {
        store.db
          .update(sqliteSchema.variants)
          .set({ stock: newStock, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.variants.id, id))
          .run()
        return
      }
      await store.db
        .update(postgresSchema.variants)
        .set({ stock: newStock, updatedAt })
        .where(eq(postgresSchema.variants.id, id))
    },
    async delete(id) {
      if (store.kind === 'sqlite') {
        store.db.delete(sqliteSchema.variants).where(eq(sqliteSchema.variants.id, id)).run()
        return
      }
      await store.db.delete(postgresSchema.variants).where(eq(postgresSchema.variants.id, id))
    },
  }
}
