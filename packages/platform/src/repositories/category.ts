import { asc, eq, gt } from 'drizzle-orm'
import type { Category } from '@nymbalhq/types'
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

export interface CategoryRepository extends StoreRepository {
  findById(tx: ReadTx, id: string): Promise<Category | null>
  findBySlug(tx: ReadTx, slug: string): Promise<Category | null>
  list(tx: ReadTx): Promise<Category[]>
  /** Rows by id after `page.after`: a walk over the table that a concurrent write cannot make skip a row. */
  listPage(tx: ReadTx, page: KeysetPage): Promise<Category[]>
  insert(tx: Tx, c: CategoryInsert): Promise<void>
  update(tx: Tx, id: string, patch: CategoryUpdate): Promise<void>
  delete(tx: Tx, id: string): Promise<void>
}

export function createCategoryRepository(store: CommandStore): CategoryRepository {
  return {
    store,
    async findById(tx, id) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.categories)
          .where(eq(sqliteSchema.categories.id, id))
          .get()
        return row ? rowToCategory(row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.categories)
        .where(eq(postgresSchema.categories.id, id))
      return row ? rowToCategory(row as Record<string, unknown>) : null
    },
    async findBySlug(tx, slug) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.categories)
          .where(eq(sqliteSchema.categories.slug, slug))
          .get()
        return row ? rowToCategory(row as Record<string, unknown>) : null
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.categories)
        .where(eq(postgresSchema.categories.slug, slug))
      return row ? rowToCategory(row as Record<string, unknown>) : null
    },
    async listPage(tx, page) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.categories
        const rows = sqliteDb(tx)
          .select()
          .from(t)
          .where(page.after === undefined ? undefined : gt(t.id, page.after))
          .orderBy(asc(t.id))
          .limit(page.limit)
          .all()
        return rows.map((r) => rowToCategory(r as Record<string, unknown>))
      }
      const t = postgresSchema.categories
      const rows = await postgresDb(tx)
        .select()
        .from(t)
        .where(page.after === undefined ? undefined : gt(t.id, page.after))
        .orderBy(asc(t.id))
        .limit(page.limit)
      return rows.map((r) => rowToCategory(r as Record<string, unknown>))
    },
    async list(tx) {
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx).select().from(sqliteSchema.categories).all()
        return rows.map((r) => rowToCategory(r as Record<string, unknown>))
      }
      const rows = await postgresDb(tx).select().from(postgresSchema.categories)
      return rows.map((r) => rowToCategory(r as Record<string, unknown>))
    },
    async insert(tx, c) {
      const common = {
        id: c.id,
        parentId: c.parentId ?? null,
        slug: c.slug,
        name: c.name,
        description: c.description ?? '',
        position: c.position ?? 0,
      }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.categories)
          .values({ ...common, createdAt: c.createdAt.toISOString() })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.categories)
        .values({ ...common, createdAt: c.createdAt })
    },
    async update(tx, id, patch) {
      const set: Record<string, unknown> = {}
      if (patch.parentId !== undefined) set.parentId = patch.parentId
      if (patch.name !== undefined) set.name = patch.name
      if (patch.description !== undefined) set.description = patch.description
      if (patch.position !== undefined) set.position = patch.position
      if (Object.keys(set).length === 0) return
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sqliteSchema.categories)
          .set(set)
          .where(eq(sqliteSchema.categories.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(postgresSchema.categories)
        .set(set)
        .where(eq(postgresSchema.categories.id, id))
    },
    async delete(tx, id) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx).delete(sqliteSchema.categories).where(eq(sqliteSchema.categories.id, id)).run()
        return
      }
      await postgresDb(tx)
        .delete(postgresSchema.categories)
        .where(eq(postgresSchema.categories.id, id))
    },
  }
}
