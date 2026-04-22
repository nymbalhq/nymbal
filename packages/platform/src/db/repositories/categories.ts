import type { CommandStore } from '../command-store.js'
import * as sqliteSchema from '../schema/sqlite.js'
import * as postgresSchema from '../schema/postgres.js'
import type { CategoryRow } from '../schema/index.js'

export interface CategoryInsert {
  id: string
  slug: string
  name: string
  description: string
  createdAt: Date
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
          ...item,
          createdAt: item.createdAt.toISOString(),
        }))
        store.db.insert(sqliteSchema.categories).values(rows).run()
        return
      }
      await store.db.insert(postgresSchema.categories).values(items)
    },
  }
}
