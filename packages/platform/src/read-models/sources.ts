import type { Category, Product, ProductSnapshot } from '@nymbalhq/types'
import type { ReadTx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import { buildOrderDoc, type OrderDoc } from './builders.js'

// What the builders are given, read from the command store: the same reads for a live projection at handle time and
// for a rebuild's pages.

type CatalogueRepos = Pick<Repositories, 'product' | 'variant' | 'category' | 'productCategory'>

/** The product with its variants and category ids. The ids are sorted: the join table keeps no order of its own. */
export async function productSnapshot(
  tx: ReadTx,
  repos: Pick<Repositories, 'variant' | 'productCategory'>,
  product: Product,
): Promise<ProductSnapshot> {
  const variants = await repos.variant.findByProduct(tx, product.id)
  const categoryIds = await repos.productCategory.listCategoriesForProduct(tx, product.id)
  return { ...product, variants, categoryIds: [...categoryIds].sort() }
}

/** The category rows of `ids` that exist, by id. */
export async function categoriesOf(
  tx: ReadTx,
  repos: Pick<Repositories, 'category'>,
  ids: readonly string[],
): Promise<Map<string, Category>> {
  const found = new Map<string, Category>()
  for (const id of new Set(ids)) {
    const category = await repos.category.findById(tx, id)
    if (category) found.set(id, category)
  }
  return found
}

/** The product as its document is built from it, or null when it is gone. */
export async function loadProduct(
  tx: ReadTx,
  repos: CatalogueRepos,
  productId: string,
): Promise<{ snapshot: ProductSnapshot; categories: Map<string, Category> } | null> {
  const product = await repos.product.findById(tx, productId)
  if (!product) return null
  const snapshot = await productSnapshot(tx, repos, product)
  return { snapshot, categories: await categoriesOf(tx, repos, snapshot.categoryIds) }
}

/** The order's document, or null when it is gone. */
export async function loadOrderDoc(
  tx: ReadTx,
  repos: Pick<Repositories, 'order' | 'orderHistory'>,
  orderId: string,
): Promise<OrderDoc | null> {
  const order = await repos.order.findById(tx, orderId)
  if (!order) return null
  return buildOrderDoc(order, await repos.orderHistory.listByOrder(tx, order.id))
}
