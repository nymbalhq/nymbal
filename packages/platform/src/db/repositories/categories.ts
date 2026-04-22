import type { CommandStore } from '../command-store.js'
import * as sqliteSchema from '../schema/sqlite.js'
import * as postgresSchema from '../schema/postgres.js'

export interface CategoryInsert {
  id: string
  parentId?: string | null
  slug: string
  name: string
  description: string
  position?: number
  createdAt: Date
}

export interface CategoryRow {
  id: string
  parentId: string | null
  slug: string
  name: string
  description: string
  position: number
  createdAt: Date | string
}

export function createCategoryRepository(store: CommandStore) {
  return {
    async findAll(): Promise<CategoryRow[]> {
      if (store.kind === 'sqlite') {
        const rows = store.db.select().from(sqliteSchema.categories).all()
        return rows as CategoryRow[]
      }
      const rows = await store.db.select().from(postgresSchema.categories)
      return rows as CategoryRow[]
    },

    async insertMany(items: CategoryInsert[]): Promise<void> {
      if (items.length === 0) return
      if (store.kind === 'sqlite') {
        const rows = items.map((item) => ({
          id: item.id,
          parentId: item.parentId ?? null,
          slug: item.slug,
          name: item.name,
          description: item.description,
          position: item.position ?? 0,
          createdAt: item.createdAt.toISOString(),
        }))
        store.db.insert(sqliteSchema.categories).values(rows).run()
        return
      }
      const rows = items.map((item) => ({
        id: item.id,
        parentId: item.parentId ?? null,
        slug: item.slug,
        name: item.name,
        description: item.description,
        position: item.position ?? 0,
        createdAt: item.createdAt,
      }))
      await store.db.insert(postgresSchema.categories).values(rows)
    },
  }
}
