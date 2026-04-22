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
} from '@nymbal/types'
import type { CommandStore } from '../db/command-store.js'
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
  variants?: Array<Omit<VariantInsert, 'id' | 'productId' | 'createdAt' | 'updatedAt'> & { id?: string }>
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
  list(opts?: { status?: ProductStatus; limit?: number; offset?: number }): Promise<ProductSnapshot[]>
}

export interface CreateProductServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
}

async function snapshot(
  repos: Repositories,
  product: Product,
): Promise<ProductSnapshot> {
  const [variants, categoryIds] = await Promise.all([
    repos.variant.findByProduct(product.id),
    repos.productCategory.listCategoriesForProduct(product.id),
  ])
  return { ...product, variants, categoryIds }
}

export function createProductService(deps: CreateProductServiceDeps): ProductService {
  const { store, repos, publisher } = deps

  async function requireProduct(id: string): Promise<Product> {
    const product = await repos.product.findById(id)
    if (!product) throw new NotFoundError('product', id)
    return product
  }

  return {
    async create(input) {
      if (!input.slug.trim()) throw new ValidationError('Product slug is required')
      if (!input.name.trim()) throw new ValidationError('Product name is required')
      const existing = await repos.product.findBySlug(input.slug)
      if (existing) {
        throw new ValidationError(`Product slug already exists: ${input.slug}`, {
          context: { slug: input.slug },
        })
      }
      return store.transaction(async () => {
        const now = new Date()
        const productId = uuidv7()
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
        await repos.product.insert(insert)
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
          await repos.variant.insert(vi)
          const stored = await repos.variant.findById(id)
          if (stored) variantRows.push(stored)
        }
        for (const categoryId of input.categoryIds ?? []) {
          await repos.productCategory.attach(productId, categoryId)
        }
        const created = await requireProduct(productId)
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
      return store.transaction(async () => {
        const product = await requireProduct(id)
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
        await repos.product.update(product.id, updateInput)
        if (input.categoryIds) {
          await repos.productCategory.detachAllForProduct(product.id)
          for (const categoryId of input.categoryIds) {
            await repos.productCategory.attach(product.id, categoryId)
          }
        }
        const snap = await snapshot(repos, await requireProduct(product.id))
        await publisher.publish(EVT_PRODUCT_UPDATED, { product: snap })
        return snap
      })
    },

    async delete(id) {
      const product = await requireProduct(id)
      await store.transaction(async () => {
        await repos.productCategory.detachAllForProduct(product.id)
        const variants = await repos.variant.findByProduct(product.id)
        for (const v of variants) await repos.variant.delete(v.id)
        await repos.product.delete(product.id)
      })
      await publisher.publish(EVT_PRODUCT_DELETED, {
        productId: product.id,
        slug: product.slug,
      })
    },

    async publish(id) {
      const product = await requireProduct(id)
      if (product.status === 'active') return
      await repos.product.setStatus(product.id, 'active', new Date())
      await publisher.publish(EVT_PRODUCT_PUBLISHED, {
        productId: product.id,
        slug: product.slug,
      })
      const fresh = await requireProduct(product.id)
      const snap = await snapshot(repos, fresh)
      await publisher.publish(EVT_PRODUCT_UPDATED, { product: snap })
    },

    async unpublish(id) {
      const product = await requireProduct(id)
      if (product.status === 'draft') return
      await repos.product.setStatus(product.id, 'draft', new Date())
      await publisher.publish(EVT_PRODUCT_UNPUBLISHED, {
        productId: product.id,
        slug: product.slug,
      })
      const fresh = await requireProduct(product.id)
      const snap = await snapshot(repos, fresh)
      await publisher.publish(EVT_PRODUCT_UPDATED, { product: snap })
    },

    async getById(id) {
      return snapshot(repos, await requireProduct(id))
    },

    async getBySlug(slug) {
      const product = await repos.product.findBySlug(slug)
      if (!product) throw new NotFoundError('product', slug)
      return snapshot(repos, product)
    },

    async list(opts = {}) {
      const products = await repos.product.list(opts)
      const out: ProductSnapshot[] = []
      for (const p of products) {
        out.push(await snapshot(repos, p))
      }
      return out
    },
  }
}
