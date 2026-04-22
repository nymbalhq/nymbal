import { eq } from 'drizzle-orm'
import type { CommandStore } from '../command-store.js'
import * as sqliteSchema from '../schema/sqlite.js'
import * as postgresSchema from '../schema/postgres.js'

export interface ProductInsert {
  id: string
  slug: string
  name: string
  description: string
  shortDescription?: string
  status?: 'draft' | 'active' | 'archived'
  type?: 'simple' | 'variable'
  seoTitle?: string
  seoDescription?: string
  media?: unknown[]
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface ProductRow {
  id: string
  slug: string
  name: string
  description: string
  shortDescription: string
  status: 'draft' | 'active' | 'archived'
  type: 'simple' | 'variable'
  seoTitle: string
  seoDescription: string
  media: unknown[]
  metadata: Record<string, unknown>
  createdAt: Date | string
  updatedAt: Date | string
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return (value ?? fallback) as T
}

function rowToDomain(row: Record<string, unknown>): ProductRow {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ''),
    shortDescription: String(row.shortDescription ?? ''),
    status: row.status as 'draft' | 'active' | 'archived',
    type: row.type as 'simple' | 'variable',
    seoTitle: String(row.seoTitle ?? ''),
    seoDescription: String(row.seoDescription ?? ''),
    media: parseJson(row.media, [] as unknown[]),
    metadata: parseJson(row.metadata, {} as Record<string, unknown>),
    createdAt: row.createdAt as Date | string,
    updatedAt: row.updatedAt as Date | string,
  }
}

export function createProductRepository(store: CommandStore) {
  return {
    async findAll(): Promise<ProductRow[]> {
      if (store.kind === 'sqlite') {
        const rows = store.db.select().from(sqliteSchema.products).all()
        return rows.map((r) => rowToDomain(r as Record<string, unknown>))
      }
      const rows = await store.db.select().from(postgresSchema.products)
      return rows.map((r) => rowToDomain(r as Record<string, unknown>))
    },

    async findBySlug(slug: string): Promise<ProductRow | null> {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.products)
          .where(eq(sqliteSchema.products.slug, slug))
          .get()
        return row ? rowToDomain(row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.products)
        .where(eq(postgresSchema.products.slug, slug))
      return row ? rowToDomain(row as Record<string, unknown>) : null
    },

    async insertMany(items: ProductInsert[]): Promise<void> {
      if (items.length === 0) return
      if (store.kind === 'sqlite') {
        const rows = items.map((item) => ({
          id: item.id,
          slug: item.slug,
          name: item.name,
          description: item.description,
          shortDescription: item.shortDescription ?? '',
          status: item.status ?? 'active',
          type: item.type ?? 'simple',
          seoTitle: item.seoTitle ?? '',
          seoDescription: item.seoDescription ?? '',
          media: JSON.stringify(item.media ?? []),
          metadata: JSON.stringify(item.metadata ?? {}),
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        }))
        store.db.insert(sqliteSchema.products).values(rows).run()
        return
      }
      const rows = items.map((item) => ({
        id: item.id,
        slug: item.slug,
        name: item.name,
        description: item.description,
        shortDescription: item.shortDescription ?? '',
        status: item.status ?? 'active',
        type: item.type ?? 'simple',
        seoTitle: item.seoTitle ?? '',
        seoDescription: item.seoDescription ?? '',
        media: item.media ?? [],
        metadata: item.metadata ?? {},
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }))
      await store.db.insert(postgresSchema.products).values(rows)
    },
  }
}
