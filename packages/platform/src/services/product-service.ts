import { v7 as uuidv7 } from 'uuid'
import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_UPDATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_PUBLISHED,
  EVT_PRODUCT_UNPUBLISHED,
  NotFoundError,
  ValidationError,
  type Product,
  type ProductStatus,
  type Variant,
  type ProductSnapshot,
  type Logger,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore, ReadTx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { ProductInsert, ProductUpdate } from '../repositories/product.js'
import type { VariantInsert } from '../repositories/variant.js'
import type { EventPublisher } from '../events/publisher.js'

export interface ProductCreateInput {
  slug: string
  name: string
  description?: string
  shortDescription?: string
  status?: ProductStatus
  type?: 'simple' | 'variable'
  seoTitle?: string
  seoDescription?: string
  media?: Product['media']
  metadata?: Record<string, unknown>
  categoryIds?: string[]
  variants?: Array<
    Omit<VariantInsert, 'id' | 'productId' | 'createdAt' | 'updatedAt'> & { id?: string }
  >
}

export interface ProductUpdateInput extends Omit<ProductUpdate, 'updatedAt'> {
  categoryIds?: string[]
}

export interface ProductService {
  create(input: ProductCreateInput): Promise<ProductSnapshot>
  update(id: string, input: ProductUpdateInput): Promise<ProductSnapshot>
  delete(id: string): Promise<void>
  publish(id: string): Promise<void>
  unpublish(id: string): Promise<void>
  getById(id: string): Promise<ProductSnapshot>
  getBySlug(slug: string): Promise<ProductSnapshot>
  list(opts?: {
    status?: ProductStatus
    limit?: number
    offset?: number
  }): Promise<ProductSnapshot[]>
}

export interface CreateProductServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
}

async function snapshot(
  tx: ReadTx,
  repos: Repositories,
  product: Product,
): Promise<ProductSnapshot> {
  const [variants, categoryIds] = await Promise.all([
    repos.variant.findByProduct(tx, product.id),
    repos.productCategory.listCategoriesForProduct(tx, product.id),
  ])
  return { ...product, variants, categoryIds }
}

export function createProductService(deps: CreateProductServiceDeps): ProductService {
  const { store, repos, publisher } = deps

  async function requireProduct(tx: ReadTx, id: string): Promise<Product> {
    const product = await repos.product.findById(tx, id)
    if (!product) throw new NotFoundError('product', id)
    return product
  }

  return {
    async create(input) {
      audit.note('product.create')
      if (!input.slug.trim()) throw new ValidationError('Product slug is required')
      if (!input.name.trim()) throw new ValidationError('Product name is required')
      const existing = await store.read((tx) => repos.product.findBySlug(tx, input.slug))
      if (existing) {
        throw new ValidationError(`Product slug already exists: ${input.slug}`, {
          context: { slug: input.slug },
        })
      }
      return store.transaction(async (tx) => {
        const now = new Date()
        const productId = uuidv7()
        audit.note('product.create', [{ type: 'product', id: productId }])
        const insert: ProductInsert = {
          id: productId,
          slug: input.slug,
          name: input.name,
          ...(input.description !== undefined && { description: input.description }),
          ...(input.shortDescription !== undefined && { shortDescription: input.shortDescription }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.type !== undefined && { type: input.type }),
          ...(input.seoTitle !== undefined && { seoTitle: input.seoTitle }),
          ...(input.seoDescription !== undefined && { seoDescription: input.seoDescription }),
          ...(input.media !== undefined && { media: input.media }),
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          createdAt: now,
          updatedAt: now,
        }
        await repos.product.insert(tx, insert)
        const variantRows: Variant[] = []
        for (const v of input.variants ?? []) {
          const id = v.id ?? uuidv7()
          const vi: VariantInsert = {
            ...v,
            id,
            productId,
            createdAt: now,
            updatedAt: now,
          }
          await repos.variant.insert(tx, vi)
          const stored = await repos.variant.findById(tx, id)
          if (stored) variantRows.push(stored)
        }
        for (const categoryId of input.categoryIds ?? []) {
          await repos.productCategory.attach(tx, productId, categoryId)
        }
        const created = await requireProduct(tx, productId)
        const snap: ProductSnapshot = {
          ...created,
          variants: variantRows,
          categoryIds: input.categoryIds ?? [],
        }
        await publisher.publish(EVT_PRODUCT_CREATED, { product: snap })
        return snap
      })
    },

    async update(id, input) {
      return store.transaction(async (tx) => {
        audit.note('product.update', [{ type: 'product', id }])
        const product = await requireProduct(tx, id)
        const now = new Date()
        const updateInput: ProductUpdate = {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.shortDescription !== undefined && { shortDescription: input.shortDescription }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.type !== undefined && { type: input.type }),
          ...(input.seoTitle !== undefined && { seoTitle: input.seoTitle }),
          ...(input.seoDescription !== undefined && { seoDescription: input.seoDescription }),
          ...(input.media !== undefined && { media: input.media }),
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          updatedAt: now,
        }
        await repos.product.update(tx, product.id, updateInput)
        if (input.categoryIds) {
          await repos.productCategory.detachAllForProduct(tx, product.id)
          for (const categoryId of input.categoryIds) {
            await repos.productCategory.attach(tx, product.id, categoryId)
          }
        }
        const snap = await snapshot(tx, repos, await requireProduct(tx, product.id))
        await publisher.publish(EVT_PRODUCT_UPDATED, { product: snap })
        return snap
      })
    },

    async delete(id) {
      await store.transaction(async (tx) => {
        audit.note('product.delete', [{ type: 'product', id }])
        const product = await requireProduct(tx, id)
        await repos.productCategory.detachAllForProduct(tx, product.id)
        const variants = await repos.variant.findByProduct(tx, product.id)
        for (const v of variants) await repos.variant.delete(tx, v.id)
        await repos.product.delete(tx, product.id)
        await publisher.publish(EVT_PRODUCT_DELETED, {
          productId: product.id,
          slug: product.slug,
        })
      })
    },

    async publish(id) {
      await store.transaction(async (tx) => {
        audit.note('product.publish', [{ type: 'product', id }])
        const product = await requireProduct(tx, id)
        if (product.status === 'active') return
        await repos.product.setStatus(tx, product.id, 'active', new Date())
        await publisher.publish(EVT_PRODUCT_PUBLISHED, {
          productId: product.id,
          slug: product.slug,
        })
        const fresh = await requireProduct(tx, product.id)
        const snap = await snapshot(tx, repos, fresh)
        await publisher.publish(EVT_PRODUCT_UPDATED, { product: snap })
      })
    },

    async unpublish(id) {
      await store.transaction(async (tx) => {
        audit.note('product.unpublish', [{ type: 'product', id }])
        const product = await requireProduct(tx, id)
        if (product.status === 'draft') return
        await repos.product.setStatus(tx, product.id, 'draft', new Date())
        await publisher.publish(EVT_PRODUCT_UNPUBLISHED, {
          productId: product.id,
          slug: product.slug,
        })
        const fresh = await requireProduct(tx, product.id)
        const snap = await snapshot(tx, repos, fresh)
        await publisher.publish(EVT_PRODUCT_UPDATED, { product: snap })
      })
    },

    async getById(id) {
      return store.read(async (tx) => snapshot(tx, repos, await requireProduct(tx, id)))
    },

    async getBySlug(slug) {
      return store.read(async (tx) => {
        const product = await repos.product.findBySlug(tx, slug)
        if (!product) throw new NotFoundError('product', slug)
        return snapshot(tx, repos, product)
      })
    },

    async list(opts = {}) {
      return store.read(async (tx) => {
        const products = await repos.product.list(tx, opts)
        const out: ProductSnapshot[] = []
        for (const p of products) {
          out.push(await snapshot(tx, repos, p))
        }
        return out
      })
    },
  }
}
