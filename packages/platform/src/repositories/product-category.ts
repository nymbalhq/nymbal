import { and, eq } from 'drizzle-orm'
import type { CommandStore } from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'

export interface ProductCategoryRepository {
  attach(productId: string, categoryId: string): Promise<void>
  detach(productId: string, categoryId: string): Promise<void>
  detachAllForProduct(productId: string): Promise<void>
  listCategoriesForProduct(productId: string): Promise<string[]>
  listProductsForCategory(categoryId: string): Promise<string[]>
}

export function createProductCategoryRepository(store: CommandStore): ProductCategoryRepository {
  return {
    async attach(productId, categoryId) {
      if (store.kind === 'sqlite') {
        store.db
          .insert(sqliteSchema.productCategories)
          .values({ productId, categoryId })
          .onConflictDoNothing()
          .run()
        return
      }
      await store.db
        .insert(postgresSchema.productCategories)
        .values({ productId, categoryId })
        .onConflictDoNothing()
    },
    async detach(productId, categoryId) {
      if (store.kind === 'sqlite') {
        store.db
          .delete(sqliteSchema.productCategories)
          .where(
            and(
              eq(sqliteSchema.productCategories.productId, productId),
              eq(sqliteSchema.productCategories.categoryId, categoryId),
            ),
          )
          .run()
        return
      }
      await store.db
        .delete(postgresSchema.productCategories)
        .where(
          and(
            eq(postgresSchema.productCategories.productId, productId),
            eq(postgresSchema.productCategories.categoryId, categoryId),
          ),
        )
    },
    async detachAllForProduct(productId) {
      if (store.kind === 'sqlite') {
        store.db
          .delete(sqliteSchema.productCategories)
          .where(eq(sqliteSchema.productCategories.productId, productId))
          .run()
        return
      }
      await store.db
        .delete(postgresSchema.productCategories)
        .where(eq(postgresSchema.productCategories.productId, productId))
    },
    async listCategoriesForProduct(productId) {
      if (store.kind === 'sqlite') {
        const rows = store.db
          .select({ categoryId: sqliteSchema.productCategories.categoryId })
          .from(sqliteSchema.productCategories)
          .where(eq(sqliteSchema.productCategories.productId, productId))
          .all()
        return rows.map((r) => r.categoryId)
      }
      const rows = await store.db
        .select({ categoryId: postgresSchema.productCategories.categoryId })
        .from(postgresSchema.productCategories)
        .where(eq(postgresSchema.productCategories.productId, productId))
      return rows.map((r) => r.categoryId)
    },
    async listProductsForCategory(categoryId) {
      if (store.kind === 'sqlite') {
        const rows = store.db
          .select({ productId: sqliteSchema.productCategories.productId })
          .from(sqliteSchema.productCategories)
          .where(eq(sqliteSchema.productCategories.categoryId, categoryId))
          .all()
        return rows.map((r) => r.productId)
      }
      const rows = await store.db
        .select({ productId: postgresSchema.productCategories.productId })
        .from(postgresSchema.productCategories)
        .where(eq(postgresSchema.productCategories.categoryId, categoryId))
      return rows.map((r) => r.productId)
    },
  }
}
