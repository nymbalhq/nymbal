import { eq } from 'drizzle-orm'
import type { Category } from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { fromTimestamp } from './json.js'

export interface CategoryInsert {
  id: string
  parentId?: string | null
  slug: string
  name: string
  description?: string
  position?: number
  createdAt: Date
}

export interface CategoryUpdate {
  parentId?: string | null
  name?: string
  description?: string
  position?: number
}

function rowToCategory(row: Record<string, unknown>): Category {
  return {
    id: String(row.id),
    parentId: (row.parentId as string | null) ?? null,
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ''),
    position: Number(row.position ?? 0),
    createdAt: fromTimestamp(row.createdAt),
  }
}

export interface CategoryRepository {
  findById(id: string): Promise<Category | null>
  findBySlug(slug: string): Promise<Category | null>
  list(): Promise<Category[]>
  insert(c: CategoryInsert): Promise<void>
  update(id: string, patch: CategoryUpdate): Promise<void>
  delete(id: string): Promise<void>
}

export function createCategoryRepository(store: CommandStore): CategoryRepository {
  return {
    async findById(id) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.categories)
          .where(eq(sqliteSchema.categories.id, id))
          .get()
        return row ? rowToCategory(row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.categories)
        .where(eq(postgresSchema.categories.id, id))
      return row ? rowToCategory(row as Record<string, unknown>) : null
    },
    async findBySlug(slug) {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.categories)
          .where(eq(sqliteSchema.categories.slug, slug))
          .get()
        return row ? rowToCategory(row as Record<string, unknown>) : null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.categories)
        .where(eq(postgresSchema.categories.slug, slug))
      return row ? rowToCategory(row as Record<string, unknown>) : null
    },
    async list() {
      if (store.kind === 'sqlite') {
        const rows = store.db.select().from(sqliteSchema.categories).all()
        return rows.map((r) => rowToCategory(r as Record<string, unknown>))
      }
      const rows = await store.db.select().from(postgresSchema.categories)
      return rows.map((r) => rowToCategory(r as Record<string, unknown>))
    },
    async insert(c) {
      const common = {
        id: c.id,
        parentId: c.parentId ?? null,
        slug: c.slug,
        name: c.name,
        description: c.description ?? '',
        position: c.position ?? 0,
      }
      if (store.kind === 'sqlite') {
        store.db
          .insert(sqliteSchema.categories)
          .values({ ...common, createdAt: c.createdAt.toISOString() })
          .run()
        return
      }
      await store.db
        .insert(postgresSchema.categories)
        .values({ ...common, createdAt: c.createdAt })
    },
    async update(id, patch) {
      const set: Record<string, unknown> = {}
      if (patch.parentId !== undefined) set.parentId = patch.parentId
      if (patch.name !== undefined) set.name = patch.name
      if (patch.description !== undefined) set.description = patch.description
      if (patch.position !== undefined) set.position = patch.position
      if (Object.keys(set).length === 0) return
      if (store.kind === 'sqlite') {
        store.db.update(sqliteSchema.categories).set(set).where(eq(sqliteSchema.categories.id, id)).run()
        return
      }
      await store.db
        .update(postgresSchema.categories)
        .set(set)
        .where(eq(postgresSchema.categories.id, id))
    },
    async delete(id) {
      if (store.kind === 'sqlite') {
        store.db.delete(sqliteSchema.categories).where(eq(sqliteSchema.categories.id, id)).run()
        return
      }
      await store.db.delete(postgresSchema.categories).where(eq(postgresSchema.categories.id, id))
    },
  }
}
