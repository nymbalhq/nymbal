import { asc, eq, gt } from 'drizzle-orm'
import type { Product, ProductStatus, ProductType, ProductMedia } from '@nymbalhq/types'
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
import type { KeysetPage } from './page.js'
import { parseJson, serialiseJson, fromTimestamp } from './json.js'

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

export interface ProductRepository extends StoreRepository {
  findById(tx: ReadTx, id: string): Promise<Product | null>
  findBySlug(tx: ReadTx, slug: string): Promise<Product | null>
  list(
    tx: ReadTx,
    opts?: { status?: ProductStatus; limit?: number; offset?: number },
  ): Promise<Product[]>
  /** Rows by id after `page.after`: a walk over the table that a concurrent write cannot make skip a row. */
  listPage(tx: ReadTx, page: KeysetPage): Promise<Product[]>
  insert(tx: Tx, p: ProductInsert): Promise<void>
  update(tx: Tx, id: string, patch: ProductUpdate): Promise<void>
  delete(tx: Tx, id: string): Promise<void>
  setStatus(tx: Tx, id: string, status: ProductStatus, updatedAt: Date): Promise<void>
}

export function createProductRepository(store: CommandStore): ProductRepository {
  async function _find(tx: ReadTx, column: 'id' | 'slug', value: string): Promise<Product | null> {
    if (tx.kind === 'sqlite') {
      const col = column === 'id' ? sqliteSchema.products.id : sqliteSchema.products.slug
      const row = sqliteDb(tx).select().from(sqliteSchema.products).where(eq(col, value)).get()
      return row ? rowToProduct(tx.kind, row as Record<string, unknown>) : null
    }
    const col = column === 'id' ? postgresSchema.products.id : postgresSchema.products.slug
    const [row] = await postgresDb(tx).select().from(postgresSchema.products).where(eq(col, value))
    return row ? rowToProduct(tx.kind, row as Record<string, unknown>) : null
  }

  return {
    store,
    async findById(tx, id) {
      return _find(tx, 'id', id)
    },
    async findBySlug(tx, slug) {
      return _find(tx, 'slug', slug)
    },
    async listPage(tx, page) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.products
        const rows = sqliteDb(tx)
          .select()
          .from(t)
          .where(page.after === undefined ? undefined : gt(t.id, page.after))
          .orderBy(asc(t.id))
          .limit(page.limit)
          .all()
        return rows.map((r) => rowToProduct('sqlite', r as Record<string, unknown>))
      }
      const t = postgresSchema.products
      const rows = await postgresDb(tx)
        .select()
        .from(t)
        .where(page.after === undefined ? undefined : gt(t.id, page.after))
        .orderBy(asc(t.id))
        .limit(page.limit)
      return rows.map((r) => rowToProduct('postgres', r as Record<string, unknown>))
    },
    async list(tx, opts = {}) {
      const limit = opts.limit ?? 100
      const offset = opts.offset ?? 0
      if (tx.kind === 'sqlite') {
        const base = sqliteDb(tx).select().from(sqliteSchema.products)
        const filtered = opts.status
          ? base.where(eq(sqliteSchema.products.status, opts.status))
          : base
        const rows = filtered.limit(limit).offset(offset).all()
        return rows.map((r) => rowToProduct('sqlite', r as Record<string, unknown>))
      }
      const base = postgresDb(tx).select().from(postgresSchema.products)
      const filtered = opts.status
        ? base.where(eq(postgresSchema.products.status, opts.status))
        : base
      const rows = await filtered.limit(limit).offset(offset)
      return rows.map((r) => rowToProduct('postgres', r as Record<string, unknown>))
    },
    async insert(tx, p) {
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
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
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
      await postgresDb(tx)
        .insert(postgresSchema.products)
        .values({
          ...common,
          media: p.media ?? [],
          metadata: p.metadata ?? {},
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })
    },
    async update(tx, id, patch) {
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
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.products)
          .set(sq)
          .where(eq(sqliteSchema.products.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.products)
        .set(pg)
        .where(eq(postgresSchema.products.id, id))
    },
    async delete(tx, id) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx).delete(sqliteSchema.products).where(eq(sqliteSchema.products.id, id)).run()
        return
      }
      await postgresDb(tx).delete(postgresSchema.products).where(eq(postgresSchema.products.id, id))
    },
    async setStatus(tx, id, status, updatedAt) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.products)
          .set({ status, updatedAt: updatedAt.toISOString() })
          .where(eq(sqliteSchema.products.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.products)
        .set({ status, updatedAt })
        .where(eq(postgresSchema.products.id, id))
    },
  }
}
