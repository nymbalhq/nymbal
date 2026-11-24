import { v7 as uuidv7 } from 'uuid'
import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_UPDATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_PUBLISHED,
  EVT_PRODUCT_UNPUBLISHED,
  EVT_PRODUCT_VARIANT_PRICE_CHANGED,
  HttpError,
  NotFoundError,
  ValidationError,
  type Product,
  type ProductStatus,
  type Variant,
  type ProductSnapshot,
  type Logger,
} from '@nymbalhq/types'
import { sanitizeDescription } from './description.js'
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
  taxCode?: string | null
  brand?: string
  categoryIds?: string[]
  variants?: Array<
    Omit<VariantInsert, 'id' | 'productId' | 'createdAt' | 'updatedAt'> & { id?: string }
  >
}

/** A variant's prices, GTIN and weight: `compareAtPriceMinor`, `gtin` or `weightGrams` omitted keeps the stored one,
 *  null clears it (a GTIN of '' too). */
export interface VariantPriceInput {
  id: string
  priceMinor: number
  compareAtPriceMinor?: number | null
  gtin?: string | null
  weightGrams?: number | null
}

export interface ProductUpdateInput extends Omit<ProductUpdate, 'updatedAt'> {
  categoryIds?: string[]
  /** Prices of some of the product's own variants; a variant left out is unchanged, and none is added or deleted. */
  variants?: VariantPriceInput[]
}

export interface ProductService {
  create(input: ProductCreateInput): Promise<ProductSnapshot>
  /**
   * Copies a product as a draft named "<name> (Copy)" with no stock. The copy takes the first free suffix, `-copy`
   * then `-copy-<k>`, whose slug and every SKU (`-COPY`, `-COPY-<k>`) no product or variant in the store holds.
   */
  duplicate(id: string): Promise<ProductSnapshot>
  update(id: string, input: ProductUpdateInput): Promise<ProductSnapshot>
  delete(id: string): Promise<void>
  publish(id: string): Promise<void>
  unpublish(id: string): Promise<void>
  getById(id: string): Promise<ProductSnapshot>
  getBySlug(slug: string): Promise<ProductSnapshot>
  list(opts?: {
    status?: ProductStatus
    q?: string
    limit?: number
    offset?: number
  }): Promise<ProductSnapshot[]>
}

export interface CreateProductServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  /** The store's currency, which a price event names. */
  currency: string
}

/** A product as `product.*` events carry it: its variants and the ids of its categories. */
export async function productSnapshot(
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
  const { store, repos, publisher, currency } = deps

  async function requireProduct(tx: ReadTx, id: string): Promise<Product> {
    const product = await repos.product.findById(tx, id)
    if (!product) throw new NotFoundError('product', id)
    return product
  }

  const service: ProductService = {
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
          ...(input.description !== undefined && {
            description: sanitizeDescription(input.description),
          }),
          ...(input.shortDescription !== undefined && { shortDescription: input.shortDescription }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.type !== undefined && { type: input.type }),
          ...(input.seoTitle !== undefined && { seoTitle: input.seoTitle }),
          ...(input.seoDescription !== undefined && { seoDescription: input.seoDescription }),
          ...(input.media !== undefined && { media: input.media }),
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          ...(input.taxCode !== undefined && { taxCode: input.taxCode }),
          ...(input.brand !== undefined && { brand: input.brand }),
          createdAt: now,
          updatedAt: now,
        }
        await repos.product.insert(tx, insert)
        const variantRows: Variant[] = []
        for (const v of input.variants ?? []) {
          const id = v.id ?? uuidv7()
          const vi: VariantInsert = {
            ...v,
            gtin: v.gtin || null,
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

    async duplicate(id) {
      const original = await service.getById(id)
      const suffix = await store.read(async (tx) => {
        for (let k = 1; ; k += 1) {
          const tail = k === 1 ? '' : `-${k}`
          if (await repos.product.findBySlug(tx, `${original.slug}-copy${tail}`)) continue
          let skusFree = true
          for (const v of original.variants) {
            if (await repos.variant.findBySku(tx, `${v.sku}-COPY${tail}`)) {
              skusFree = false
              break
            }
          }
          if (skusFree) return tail
        }
      })
      return service.create({
        slug: `${original.slug}-copy${suffix}`,
        name: `${original.name} (Copy)`,
        description: original.description,
        shortDescription: original.shortDescription,
        status: 'draft',
        type: original.type,
        seoTitle: original.seoTitle,
        seoDescription: original.seoDescription,
        media: original.media,
        metadata: original.metadata,
        taxCode: original.taxCode ?? null,
        brand: original.brand ?? '',
        categoryIds: original.categoryIds,
        // A copy holds no goods: stock is received into it like any new product. Its GTINs are not copied either: it
        // is a new trade item until the merchant says otherwise.
        variants: original.variants.map((v) => ({
          sku: `${v.sku}-COPY${suffix}`,
          name: v.name,
          priceMinor: v.priceMinor,
          compareAtPriceMinor: v.compareAtPriceMinor,
          weightGrams: v.weightGrams,
          dimensions: v.dimensions,
          stock: 0,
          lowStockThreshold: v.lowStockThreshold,
          options: v.options,
          status: v.status,
          taxCode: v.taxCode ?? null,
        })),
      })
    },

    async update(id, input) {
      return store.transaction(async (tx) => {
        audit.note('product.update', [{ type: 'product', id }])
        const product = await requireProduct(tx, id)
        // Every listed variant is checked before anything is written, so a refusal changes nothing. The rows are held
        // so a concurrent update compares and logs against the price this one writes, not the one both read.
        const current = new Map(
          (await repos.variant.lockByProduct(tx, product.id)).map((v) => [v.id, v]),
        )
        for (const item of input.variants ?? []) {
          if (!current.has(item.id)) {
            throw new HttpError(400, `Variant ${item.id} is not a variant of this product`, {
              code: 'product.variant_unknown',
            })
          }
        }
        const now = new Date()
        const updateInput: ProductUpdate = {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && {
            description: sanitizeDescription(input.description),
          }),
          ...(input.shortDescription !== undefined && { shortDescription: input.shortDescription }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.type !== undefined && { type: input.type }),
          ...(input.seoTitle !== undefined && { seoTitle: input.seoTitle }),
          ...(input.seoDescription !== undefined && { seoDescription: input.seoDescription }),
          ...(input.media !== undefined && { media: input.media }),
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          ...(input.taxCode !== undefined && { taxCode: input.taxCode }),
          ...(input.brand !== undefined && { brand: input.brand }),
          updatedAt: now,
        }
        await repos.product.update(tx, product.id, updateInput)
        if (input.categoryIds) {
          await repos.productCategory.detachAllForProduct(tx, product.id)
          for (const categoryId of input.categoryIds) {
            await repos.productCategory.attach(tx, product.id, categoryId)
          }
        }
        for (const item of input.variants ?? []) {
          const before = current.get(item.id)!
          const compareAtPriceMinor =
            item.compareAtPriceMinor === undefined
              ? before.compareAtPriceMinor
              : item.compareAtPriceMinor
          const storedGtin = before.gtin ?? null
          const gtin = item.gtin === undefined ? storedGtin : item.gtin || null
          const weightGrams = item.weightGrams === undefined ? before.weightGrams : item.weightGrams
          const repriced =
            item.priceMinor !== before.priceMinor ||
            compareAtPriceMinor !== before.compareAtPriceMinor
          if (!repriced && gtin === storedGtin && weightGrams === before.weightGrams) continue
          await repos.variant.update(tx, item.id, {
            priceMinor: item.priceMinor,
            compareAtPriceMinor,
            gtin,
            weightGrams,
            updatedAt: now,
          })
          current.set(item.id, {
            ...before,
            priceMinor: item.priceMinor,
            compareAtPriceMinor,
            gtin,
            weightGrams,
          })
          if (!repriced) continue
          await publisher.publish(EVT_PRODUCT_VARIANT_PRICE_CHANGED, {
            productId: product.id,
            variantId: item.id,
            previousPriceMinor: before.priceMinor,
            priceMinor: item.priceMinor,
            previousCompareAtPriceMinor: before.compareAtPriceMinor,
            compareAtPriceMinor,
            currency,
          })
        }
        const snap = await productSnapshot(tx, repos, await requireProduct(tx, product.id))
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
        const snap = await productSnapshot(tx, repos, fresh)
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
        const snap = await productSnapshot(tx, repos, fresh)
        await publisher.publish(EVT_PRODUCT_UPDATED, { product: snap })
      })
    },

    async getById(id) {
      return store.read(async (tx) => productSnapshot(tx, repos, await requireProduct(tx, id)))
    },

    async getBySlug(slug) {
      return store.read(async (tx) => {
        const product = await repos.product.findBySlug(tx, slug)
        if (!product) throw new NotFoundError('product', slug)
        return productSnapshot(tx, repos, product)
      })
    },

    async list(opts = {}) {
      return store.read(async (tx) => {
        const products = await repos.product.list(tx, opts)
        const out: ProductSnapshot[] = []
        for (const p of products) {
          out.push(await productSnapshot(tx, repos, p))
        }
        return out
      })
    },
  }
  return service
}
