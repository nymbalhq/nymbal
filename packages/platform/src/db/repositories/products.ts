import type { CommandStore } from '../command-store.js'
import * as sqliteSchema from '../schema/sqlite.js'
import * as postgresSchema from '../schema/postgres.js'
import { eq } from 'drizzle-orm'
import type { ProductRow } from '../schema/index.js'

export interface ProductInsert {
  id: string
  slug: string
  title: string
  description: string
  priceMinor: number
  currency: string
  categoryId: string
  imageUrl: string
  createdAt: Date
  updatedAt: Date
}

export function createProductRepository(store: CommandStore) {
  return {
    async findAll(): Promise<ProductRow[]> {
      if (store.kind === 'sqlite') {
        const rows = store.db.select().from(sqliteSchema.products).all()
        return rows as ProductRow[]
      }
      const rows = await store.db.select().from(postgresSchema.products)
      return rows as ProductRow[]
    },
    async findBySlug(slug: string): Promise<ProductRow | null> {
      if (store.kind === 'sqlite') {
        const row = store.db
          .select()
          .from(sqliteSchema.products)
          .where(eq(sqliteSchema.products.slug, slug))
          .get()
        return (row as ProductRow | undefined) ?? null
      }
      const [row] = await store.db
        .select()
        .from(postgresSchema.products)
        .where(eq(postgresSchema.products.slug, slug))
      return (row as ProductRow | undefined) ?? null
    },
    async insertMany(items: ProductInsert[]): Promise<void> {
      if (items.length === 0) return
      if (store.kind === 'sqlite') {
        const rows = items.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        }))
        store.db.insert(sqliteSchema.products).values(rows).run()
        return
      }
      await store.db.insert(postgresSchema.products).values(items)
    },
  }
}
