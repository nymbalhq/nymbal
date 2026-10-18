import { and, eq } from 'drizzle-orm'
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

export interface ProductCategoryRepository extends StoreRepository {
  attach(tx: Tx, productId: string, categoryId: string): Promise<void>
  detach(tx: Tx, productId: string, categoryId: string): Promise<void>
  detachAllForProduct(tx: Tx, productId: string): Promise<void>
  listCategoriesForProduct(tx: ReadTx, productId: string): Promise<string[]>
  listProductsForCategory(tx: ReadTx, categoryId: string): Promise<string[]>
}

export function createProductCategoryRepository(store: CommandStore): ProductCategoryRepository {
  return {
    store,
    async attach(tx, productId, categoryId) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .insert(sqliteSchema.productCategories)
          .values({ productId, categoryId })
          .onConflictDoNothing()
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.productCategories)
        .values({ productId, categoryId })
        .onConflictDoNothing()
    },
    async detach(tx, productId, categoryId) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
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
      await postgresDb(tx)
        .delete(postgresSchema.productCategories)
        .where(
          and(
            eq(postgresSchema.productCategories.productId, productId),
            eq(postgresSchema.productCategories.categoryId, categoryId),
          ),
        )
    },
    async detachAllForProduct(tx, productId) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .delete(sqliteSchema.productCategories)
          .where(eq(sqliteSchema.productCategories.productId, productId))
          .run()
        return
      }
      await postgresDb(tx)
        .delete(postgresSchema.productCategories)
        .where(eq(postgresSchema.productCategories.productId, productId))
    },
    async listCategoriesForProduct(tx, productId) {
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx)
          .select({ categoryId: sqliteSchema.productCategories.categoryId })
          .from(sqliteSchema.productCategories)
          .where(eq(sqliteSchema.productCategories.productId, productId))
          .all()
        return rows.map((r) => r.categoryId)
      }
      const rows = await postgresDb(tx)
        .select({ categoryId: postgresSchema.productCategories.categoryId })
        .from(postgresSchema.productCategories)
        .where(eq(postgresSchema.productCategories.productId, productId))
      return rows.map((r) => r.categoryId)
    },
    async listProductsForCategory(tx, categoryId) {
      if (tx.kind === 'sqlite') {
        const rows = sqliteDb(tx)
          .select({ productId: sqliteSchema.productCategories.productId })
          .from(sqliteSchema.productCategories)
          .where(eq(sqliteSchema.productCategories.categoryId, categoryId))
          .all()
        return rows.map((r) => r.productId)
      }
      const rows = await postgresDb(tx)
        .select({ productId: postgresSchema.productCategories.productId })
        .from(postgresSchema.productCategories)
        .where(eq(postgresSchema.productCategories.categoryId, categoryId))
      return rows.map((r) => r.productId)
    },
  }
}
