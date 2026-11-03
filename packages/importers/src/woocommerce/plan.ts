import type {
  CollisionKind,
  ExistingStoreLookup,
  ImportEntity,
  ImportPlan,
  PlanCollision,
  PlanEntity,
  ProgressCallback,
  WooCommerceImportOptions,
} from '../types.js'
import { WooCommerceClient, WooCommerceApiError } from './client.js'
import type { WcCategory, WcCustomer, WcOrder, WcProduct, WcReview, WcVariation } from './client.js'
import { mapCategory } from './mappers/category.js'
import { mapProduct } from './mappers/product.js'
import { mapCustomer } from './mappers/customer.js'
import { mapOrder } from './mappers/order.js'
import { mapReview } from './mappers/review.js'
import { categoryRefs, orderRefs, productRefs, reviewRefs } from './refs.js'

/** The time one record's write is assumed to take, until a measured figure replaces it. */
export const WRITE_MS = 20

export type WooCommercePlanOptions = Pick<
  WooCommerceImportOptions,
  'credentials' | 'entities' | 'gdpr' | 'currency' | 'concurrency'
>

export interface WooCommercePlanDeps {
  /** The target store, read-only; null when it could not be opened. */
  existing: ExistingStoreLookup | null
  onProgress?: ProgressCallback
  /** The clock requests are timed on; `performance.now` by default. */
  now?: () => number
}

const ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders', 'reviews']
const PLAN_ENTITIES: PlanEntity[] = [...ENTITIES, 'variations']
const LIST_PATH: Record<ImportEntity, string> = {
  categories: '/products/categories',
  products: '/products',
  customers: '/customers',
  orders: '/orders',
  reviews: '/products/reviews',
}

type Rec = Record<string, unknown>

function isPlainObject(v: unknown): v is Rec {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

function isPresent(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (isPlainObject(v)) return Object.keys(v).length > 0
  return true
}

/**
 * One entity's field paths: which ones carry a value in how many records, and which ones the import's code read in
 * any record. An object field is read as `key.sub`; an array is one field `key` unless its elements were read, then
 * each element field is `key[].sub`.
 */
class FieldLog {
  private readonly read = new Set<string>()
  private readonly iterated = new Set<string>()
  /** path → the records carrying it and, for an element field, its array */
  private readonly present = new Map<string, { records: number; array?: string }>()

  /** The record as the import's code will see it: every field read through it is logged. */
  watch<T extends object>(record: T): T {
    this.countPresent(record as unknown as Rec)
    return new Proxy(record, {
      get: (target, key, receiver) => {
        const value: unknown = Reflect.get(target, key, receiver)
        if (typeof key !== 'string' || !Object.hasOwn(target, key)) return value
        this.read.add(key)
        if (Array.isArray(value)) return this.watchArray(key, value)
        if (isPlainObject(value))
          return this.watchFields(value, (sub) => this.read.add(`${key}.${sub}`))
        return value
      },
    })
  }

  unmapped(): Array<{ field: string; records: number }> {
    const out: Array<{ field: string; records: number }> = []
    for (const [field, p] of this.present) {
      if (this.read.has(field)) continue
      if (p.array !== undefined && !this.iterated.has(p.array)) continue
      out.push({ field, records: p.records })
    }
    return out.sort(
      (a, b) => b.records - a.records || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0),
    )
  }

  private watchArray(key: string, items: unknown[]): unknown[] {
    return new Proxy(items, {
      get: (target, index, receiver) => {
        const value: unknown = Reflect.get(target, index, receiver)
        if (typeof index !== 'string' || !/^\d+$/.test(index) || !isPlainObject(value)) return value
        return this.watchFields(value, (sub) => {
          this.iterated.add(key)
          this.read.add(`${key}[].${sub}`)
        })
      },
    })
  }

  private watchFields(obj: Rec, onRead: (sub: string) => void): Rec {
    return new Proxy(obj, {
      get: (target, sub, receiver) => {
        if (typeof sub === 'string' && Object.hasOwn(target, sub)) onRead(sub)
        return Reflect.get(target, sub, receiver) as unknown
      },
    })
  }

  private countPresent(record: Rec): void {
    const seen = new Map<string, { array?: string }>()
    for (const [key, value] of Object.entries(record)) {
      if (isPlainObject(value)) {
        for (const [sub, v] of Object.entries(value))
          if (isPresent(v)) seen.set(`${key}.${sub}`, {})
      } else if (Array.isArray(value)) {
        if (value.length > 0) seen.set(key, {})
        for (const item of value) {
          if (!isPlainObject(item)) continue
          for (const [sub, v] of Object.entries(item)) {
            if (isPresent(v)) seen.set(`${key}[].${sub}`, { array: key })
          }
        }
      } else if (isPresent(value)) {
        seen.set(key, {})
      }
    }
    for (const [path, shape] of seen) {
      const p = this.present.get(path)
      if (p) p.records++
      else this.present.set(path, { records: 1, ...shape })
    }
  }
}

/**
 * The import, simulated: what it would create, refuse and skip, what it never reads, and what it would cost, without
 * writing anything. Records go through the import's own reads and mappers in id order, the import's order at
 * concurrency 1; the target store is only asked whether it already holds a value.
 */
export async function planWooCommerceImport(
  opts: WooCommercePlanOptions,
  deps: WooCommercePlanDeps,
): Promise<ImportPlan> {
  const emit = deps.onProgress ?? (() => undefined)
  const client = new WooCommerceClient(opts.credentials, deps.now ? { now: deps.now } : {})
  const selected = (e: ImportEntity) => opts.entities.includes(e)

  const counts = Object.fromEntries(
    ENTITIES.map((e) => [e, { source: 0, import: 0, refused: 0, skipped: 0 }]),
  ) as ImportPlan['counts']
  const fields = Object.fromEntries(PLAN_ENTITIES.map((e) => [e, new FieldLog()])) as Record<
    PlanEntity,
    FieldLog
  >

  // ── The target store and the values each record would claim ──────────────────────────────────────────────────
  let lookup = deps.existing
  let existingStore: ImportPlan['existingStore'] =
    lookup === null ? { notChecked: 'no store to check' } : 'checked'
  const held = new Map<string, boolean>()
  const ask = (store: ExistingStoreLookup, kind: CollisionKind, value: string) => {
    switch (kind) {
      case 'product-slug':
        return store.productSlugExists(value)
      case 'sku':
        return store.skuExists(value)
      case 'category-slug':
        return store.categorySlugExists(value)
      case 'customer-email':
        return store.customerEmailExists(value)
      case 'order-number':
        return store.orderNumberExists(value)
    }
  }
  /** A lookup that throws stops the store check; the plan says so and carries on with the source alone. */
  async function storeHolds(kind: CollisionKind, key: string): Promise<boolean> {
    if (lookup === null) return false
    const cached = held.get(`${kind}\0${key}`)
    if (cached !== undefined) return cached
    let answer: boolean
    try {
      answer = await ask(lookup, kind, key)
    } catch (err) {
      lookup = null
      existingStore = { notChecked: `the store lookup failed: ${String(err)}` }
      return false
    }
    held.set(`${kind}\0${key}`, answer)
    return answer
  }

  const claimed = new Map<string, string>()
  const collisions = new Map<string, PlanCollision>()
  const outcomeOf = (kind: CollisionKind) =>
    kind === 'customer-email' ? ('links-existing' as const) : ('refused' as const)
  function clash(
    kind: CollisionKind,
    at: 'source' | 'store',
    key: string,
    value: string,
    ids: string[],
  ) {
    const id = `${kind}\0${at}\0${key}`
    const c = collisions.get(id)
    if (c === undefined) {
      collisions.set(id, { kind, with: at, value, sourceIds: [...ids], outcome: outcomeOf(kind) })
      return
    }
    for (const sourceId of ids) if (!c.sourceIds.includes(sourceId)) c.sourceIds.push(sourceId)
  }
  /** Where `key` is already taken, recorded as a collision; null when the record may take it. */
  async function taken(kind: CollisionKind, key: string, value: string, sourceId: string) {
    const winner = claimed.get(`${kind}\0${key}`)
    if (winner !== undefined) {
      clash(kind, 'source', key, value, [winner, sourceId])
      return 'source' as const
    }
    if (await storeHolds(kind, key)) {
      clash(kind, 'store', key, value, [sourceId])
      return 'store' as const
    }
    return null
  }
  const claim = (kind: CollisionKind, key: string, sourceId: string) =>
    claimed.set(`${kind}\0${key}`, sourceId)

  async function* records<T extends object>(entity: ImportEntity) {
    emit({ kind: 'phase', phase: entity })
    let done = 0
    for await (const page of client.paginate<T>(LIST_PATH[entity])) {
      for (const item of page.items) {
        counts[entity].source++
        yield fields[entity].watch(item)
      }
      if (page.items.length === 0) continue
      done += page.items.length
      emit({ kind: 'progress', entity, done, total: page.total })
    }
  }

  // ── Connect ─────────────────────────────────────────────────────────────────────────────────────────────────
  emit({ kind: 'phase', phase: 'connect' })
  try {
    await client.healthCheck()
  } catch (err) {
    if (err instanceof WooCommerceApiError) throw err
    throw new Error(`Cannot connect to ${opts.credentials.url}: ${String(err)}`)
  }

  // WooCommerce id → the id the import would give the record; a placeholder, since nothing is written.
  const categoryIds = new Map<number, string>()
  const productIds = new Map<number, string>()
  const customerIds = new Map<number, string>()
  let images = 0

  if (selected('categories')) {
    for await (const wc of records<WcCategory>('categories')) {
      const sourceId = String(wc.id)
      const { parentWcId } = categoryRefs(wc)
      const input = mapCategory(wc, parentWcId ? categoryIds.get(parentWcId) : undefined)
      if (await taken('category-slug', input.slug, input.slug, sourceId)) {
        counts.categories.refused++
        continue
      }
      claim('category-slug', input.slug, sourceId)
      categoryIds.set(wc.id, `category:${sourceId}`)
      counts.categories.import++
    }
  }

  if (selected('products')) {
    const seenSlugs = new Set<string>()
    for await (const wc of records<WcProduct>('products')) {
      const sourceId = String(wc.id)
      const refs = productRefs(wc, seenSlugs)
      let variations: WcVariation[] = []
      if (refs.isVariable && refs.variationCount > 0) {
        try {
          variations = (await client.getProductVariations(wc.id)).map((v) =>
            fields.variations.watch(v),
          )
        } catch {
          // the import proceeds with no variations
        }
      }
      images += refs.imageSources.length
      const input = mapProduct(
        wc,
        variations,
        refs.categoryWcIds.flatMap((id) => categoryIds.get(id) ?? []),
        refs.imageSources.map((img) => ({ url: img.src, altText: img.alt })),
        refs.slugSuffix,
      )
      const skus = (input.variants ?? []).map((v) => v.sku)
      // Every clash is listed, though the import stops at the first.
      let refused = (await taken('product-slug', input.slug, input.slug, sourceId)) !== null
      for (const sku of skus) {
        if ((await taken('sku', sku, sku, sourceId)) !== null) refused = true
      }
      if (refused) {
        counts.products.refused++
        continue
      }
      claim('product-slug', input.slug, sourceId)
      for (const sku of skus) claim('sku', sku, sourceId)
      productIds.set(wc.id, `product:${sourceId}`)
      counts.products.import++
    }
  }

  if (selected('customers')) {
    for await (const wc of records<WcCustomer>('customers')) {
      const sourceId = String(wc.id)
      // An email already held links to that customer: imported, not refused. The value is never reported.
      const email = mapCustomer(wc, opts.gdpr).email.toLowerCase()
      if ((await taken('customer-email', email, '', sourceId)) === null) {
        claim('customer-email', email, sourceId)
      }
      customerIds.set(wc.id, `customer:${sourceId}`)
      counts.customers.import++
    }
  }

  if (selected('orders')) {
    for await (const wc of records<WcOrder>('orders')) {
      const sourceId = String(wc.id)
      const { customerWcId, lineProductWcIds } = orderRefs(wc)
      const lineProducts: Record<number, string> = {}
      for (const id of lineProductWcIds) {
        const planned = productIds.get(id)
        if (planned) lineProducts[id] = planned
      }
      const input = mapOrder(
        wc,
        customerWcId ? (customerIds.get(customerWcId) ?? null) : null,
        lineProducts,
        opts.currency,
      )
      if (await taken('order-number', input.orderNumber, input.orderNumber, sourceId)) {
        counts.orders.refused++
        continue
      }
      claim('order-number', input.orderNumber, sourceId)
      counts.orders.import++
    }
  }

  if (selected('reviews')) {
    for await (const wc of records<WcReview>('reviews')) {
      const productId = productIds.get(reviewRefs(wc).productWcId)
      if (!productId) {
        counts.reviews.skipped++
        continue
      }
      mapReview(wc, productId, null)
      counts.reviews.import++
    }
  }

  // Everything so far is a request the import makes too; the probes below are the plan's own.
  const api = client.requestStats.count

  const wontMigrate: ImportPlan['wontMigrate'] = [
    {
      item: 'coupons',
      count: await client.getTotal('/coupons'),
      why: 'Nymbal has no coupons or discount codes',
    },
    {
      item: 'tax rates',
      count: await client.getTotal('/taxes'),
      why: "Tax comes from the store's tax provider, not from WooCommerce rates",
    },
    {
      item: 'shipping zones',
      count: await client.getListLength('/shipping/zones'),
      why: "Shipping comes from the store's shipping provider",
    },
    {
      item: 'customer passwords',
      count: counts.customers.import,
      why: 'WooCommerce does not export password hashes; imported customers reset theirs',
    },
    {
      item: 'WordPress pages and posts',
      count: null,
      why: 'Content outside WooCommerce is not read',
    },
  ]
  for (const e of ENTITIES) {
    if (selected(e)) continue
    wontMigrate.push({
      item: e,
      count: await client.getTotal(LIST_PATH[e]),
      why: 'Not selected with --entities',
    })
  }

  const { count, ms } = client.requestStats
  const meanRequestMs = count > 0 ? ms / count : 0
  const writes = ENTITIES.reduce((n, e) => n + counts[e].import, 0)

  return {
    source: { url: sourceUrl(opts.credentials.url) },
    counts,
    unmapped: Object.fromEntries(
      PLAN_ENTITIES.map((e) => [e, fields[e].unmapped()]),
    ) as ImportPlan['unmapped'],
    collisions: [...collisions.values()],
    estimate: {
      requests: { api, images },
      meanRequestMs,
      writes,
      seconds: Math.ceil(
        (meanRequestMs * api + (meanRequestMs * images) / opts.concurrency + WRITE_MS * writes) /
          1000,
      ),
    },
    wontMigrate,
    existingStore,
    resumeStateFound: false,
  }
}

function sourceUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}
