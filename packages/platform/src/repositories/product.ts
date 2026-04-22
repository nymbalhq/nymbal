import { eq } from 'drizzle-orm'
import type { Product, ProductStatus, ProductType, ProductMedia } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { parseJson, serialiseJson, toIso, fromTimestamp } from './json.js'

export interface ProductInsert {
  id: string
  slug: string
  name: string
  description?: string
  shortDescription?: string
  status?: ProductStatus
  type?: ProductType
  seoTitle?: string
  seoDescription?: string
  media?: ProductMedia[]
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface ProductUpdate {
  name?: string
  description?: string
  shortDescription?: string
  status?: ProductStatus
  type?: ProductType
  seoTitle?: string
  seoDescription?: string
  media?: ProductMedia[]
  metadata?: Record<string, unknown>
  updatedAt: Date
}

function rowToProduct(store: CommandStore['kind'], row: Record<string, unknown>): Product {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ''),
    shortDescription: String(row.shortDescription ?? ''),
    status: row.status as ProductStatus,
    type: row.type as ProductType,
    seoTitle: String(row.seoTitle ?? ''),
    seoDescription: String(row.seoDescription ?? ''),
    media: parseJson<ProductMedia[]>(store, row.media, []),
    metadata: parseJson<Record<string, unknown>>(store, row.metadata, {}),
    createdAt: fromTimestamp(row.createdAt),
    updatedAt: fromTimestamp(row.updatedAt),
  }
}

export interface ProductRepository {
  findById(id: string): Promise<Product | null>
  findBySlug(slug: string): Promise<Product | null>
  list(opts?: { status?: ProductStatus; limit?: number; offset?: number }): Promise<Product[]>
  insert(p: ProductInsert): Promise<void>
  update(id: string, patch: ProductUpdate): Promise<void>
  delete(id: string): Promise<void>
  setStatus(id: string, status: ProductStatus, updatedAt: Date): Promise<void>
}

export function createProductRepository(store: CommandStore): ProductRepository {
  async function _find(column: 'id' | 'slug', value: string): Promise<Product | null> {
    if (store.kind === 'sqlite') {
      const col = column === 'id' ? sqliteSchema.products.id : sqliteSchema.products.slug
      const row = store.db.select().from(sqliteSchema.products).where(eq(col, value)).get()
      return row ? rowToProduct(store.kind, row as Record<string, unknown>) : null
    }
    const col = column === 'id' ? postgresSchema.products.id : postgresSchema.products.slug
    const [row] = await store.db.select().from(postgresSchema.products).where(eq(col, value))
    return row ? rowToProduct(store.kind, row as Record<string, unknown>) : null
  }

  return {
    async findById(id) {
      return _find('id', id)
    },
    async findBySlug(slug) {
      return _find('slug', slug)
    },
    async list(opts = {}) {
      const limit = opts.limit ?? 100
      const offset = opts.offset ?? 0
      if (store.kind === 'sqlite') {
        const base = store.db.select().from(sqliteSchema.products)
        const filtered = opts.status
          ? base.where(eq(sqliteSchema.products.status, opts.status))
          : base
        const rows = filtered.limit(limit).offset(offset).all()
        return rows.map((r) => rowToProduct('sqlite', r as Record<string, unknown>))
      }
      const base = store.db.select().from(postgresSchema.products)
      const filtered = opts.status
        ? base.where(eq(postgresSchema.products.status, opts.status))
        : base
      const rows = await filtered.limit(limit).offset(offset)
      return rows.map((r) => rowToProduct('postgres', r as Record<string, unknown>))
    },
    async insert(p) {
      const common = {
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description ?? '',
        shortDescription: p.shortDescription ?? '',
        status: p.status ?? 'draft',
        type: p.type ?? 'simple',
        seoTitle: p.seoTitle ?? '',
        seoDescription: p.seoDescription ?? '',
      }
      if (store.kind === 'sqlite') {
        store.db
          .insert(sqliteSchema.products)
          .values({
            ...common,
            media: serialiseJson('sqlite', p.media ?? []) as string,
            metadata: serialiseJson('sqlite', p.metadata ?? {}) as string,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          })
          .run()
        return
      }
      await store.db.insert(postgresSchema.products).values({
        ...common,
        media: p.media ?? [],
        metadata: p.metadata ?? {},
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })
    },
    async update(id, patch) {
      const pg: Record<string, unknown> = { updatedAt: patch.updatedAt }
      const sq: Record<string, unknown> = { updatedAt: patch.updatedAt.toISOString() }
      if (patch.name !== undefined) {
        pg.name = patch.name
        sq.name = patch.name
      }
      if (patch.description !== undefined) {
        pg.description = patch.description
        sq.description = patch.description
      }
      if (patch.shortDescription !== undefined) {
        pg.shortDescription = patch.shortDescription
        sq.shortDescription = patch.shortDescription
      }
      if (patch.status !== undefined) {
        pg.status = patch.status
        sq.status = patch.status
      }
      if (patch.type !== undefined) {
        pg.type = patch.type
        sq.type = patch.type
      }
      if (patch.seoTitle !== undefined) {
        pg.seoTitle = patch.seoTitle
        sq.seoTitle = patch.seoTitle
      }
      if (patch.seoDescription !== undefined) {
        pg.seoDescription = patch.seoDescription
        sq.seoDescription = patch.seoDescription
      }
      if (patch.media !== undefined) {
        pg.media = patch.media
        sq.media = JSON.stringify(patch.media)
      }
      if (patch.metadata !== undefined) {
        pg.metadata = patch.metadata
        sq.metadata = JSON.stringify(patch.metadata)
      }
      if (store.kind === 'sqlite') {
        store.db.update(sqliteSchema.products).set(sq).where(eq(sqliteSchema.products.id, id)).run()
        return
      }
      await store.db
        .update(postgresSchema.products)
        .set(pg)
        .where(eq(postgresSchema.products.id, id))
    },
    async delete(id) {
      if (store.kind === 'sqlite') {
        store.db.delete(sqliteSchema.products).where(eq(sqliteSchema.products.id, id)).run()
        return
      }
      await store.db.delete(postgresSchema.products).where(eq(postgresSchema.products.id, id))
    },
    async setStatus(id, status, updatedAt) {
      if (store.kind === 'sqlite') {
        store.db
          .update(sqliteSchema.products)
          .set({ status, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.products.id, id))
          .run()
        return
      }
      await store.db
        .update(postgresSchema.products)
        .set({ status, updatedAt })
        .where(eq(postgresSchema.products.id, id))
    },
  }
}
