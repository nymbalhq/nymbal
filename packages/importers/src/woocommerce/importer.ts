import type { AiAdapter } from '@nymbal/types'
import type {
  ServiceRegistry,
  Repositories,
} from '@nymbal/platform'
import { createLocalFsMediaStorage } from '@nymbal/platform'
import { join } from 'node:path'
import type { WooCommerceImportOptions, ImportState, ProgressCallback } from '../types.js'
import { loadState, freshState, saveState } from '../state.js'
import { buildReport } from '../report.js'
import { WooCommerceClient, WooCommerceApiError } from './client.js'
import type { WcCategory, WcProduct, WcVariation, WcCustomer, WcOrder, WcReview } from './client.js'
import { mapCategory } from './mappers/category.js'
import { mapProduct } from './mappers/product.js'
import { mapCustomer } from './mappers/customer.js'
import { mapOrder } from './mappers/order.js'
import { mapReview } from './mappers/review.js'
import { downloadProductImages } from './media.js'
import { runEnrichment } from './enrichment.js'
import type { ReviewsAdapter } from '@nymbal/types'

export interface WooCommerceImporterDeps {
  services: ServiceRegistry
  repos: Repositories
  adapters: { ai: AiAdapter; reviews: ReviewsAdapter }
  onProgress?: ProgressCallback
}

async function pMap<T, U>(
  items: T[],
  fn: (item: T, index: number) => Promise<U>,
  concurrency: number,
): Promise<Array<U | Error>> {
  const results: Array<U | Error> = new Array(items.length)
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      const item = items[i]
      if (item === undefined) continue
      try {
        results[i] = await fn(item, i)
      } catch (err) {
        results[i] = err instanceof Error ? err : new Error(String(err))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

export async function runWooCommerceImport(
  opts: WooCommerceImportOptions,
  deps: WooCommerceImporterDeps,
) {
  const startMs = Date.now()
  const { services, adapters, onProgress } = deps
  const emit = onProgress ?? (() => undefined)

  const client = new WooCommerceClient(opts.credentials)
  const storage = createLocalFsMediaStorage({
    root: join(opts.projectRoot, 'public', 'imported-media'),
    urlPrefix: '/imported-media',
  })

  // Load or create state
  let state: ImportState = opts.fresh
    ? freshState()
    : ((await loadState(opts.statePath)) ?? freshState())

  const checkpoint = async () => saveState(opts.statePath, state)

  // ── 1. Connect ──────────────────────────────────────────────────────────────
  emit({ kind: 'phase', phase: 'connect' })
  try {
    await client.healthCheck()
  } catch (err) {
    if (err instanceof WooCommerceApiError) throw err
    throw new Error(`Cannot connect to ${opts.credentials.url}: ${String(err)}`)
  }

  // ── 2. Categories ────────────────────────────────────────────────────────────
  if (opts.entities.includes('categories') && state.phase !== 'done') {
    emit({ kind: 'phase', phase: 'categories' })
    state.phase = 'categories'

    const startPage = state.cursors['categories']?.page ?? 1
    let done = state.importedIds.categories.length
    let total = 0

    for await (const page of client.paginate<WcCategory>('/products/categories', {}, startPage)) {
      total = page.total

      for (const wc of page.items) {
        if (state.wcToNymbalCategory[wc.id]) continue
        const nymbalParentId = wc.parent ? state.wcToNymbalCategory[wc.parent] : undefined
        try {
          const category = await services.category.create(mapCategory(wc, nymbalParentId))
          state.wcToNymbalCategory[wc.id] = category.id
          state.importedIds.categories.push(category.id)
          state.eventsEmitted++
        } catch (err) {
          state.errors.push({ phase: 'categories', id: String(wc.id), error: String(err) })
        }
        done++
        emit({ kind: 'progress', entity: 'categories', done, total })
      }

      state.cursors['categories'] = { page: state.cursors['categories']?.page ?? 1 }
      await checkpoint()
    }
  }

  // ── 3. Products ──────────────────────────────────────────────────────────────
  if (opts.entities.includes('products') && state.phase !== 'done') {
    emit({ kind: 'phase', phase: 'products' })
    state.phase = 'products'

    const startPage = state.cursors['products']?.page ?? 1
    let done = state.importedIds.products.length
    let total = 0

    const seenSlugs = new Set<string>()

    for await (const page of client.paginate<WcProduct>('/products', {}, startPage)) {
      total = page.total

      await pMap(
        page.items,
        async (wc) => {
          if (state.wcToNymbalProduct[wc.id]) return

          let variations: WcVariation[] = []
          if (wc.type === 'variable' && wc.variations.length > 0) {
            try {
              variations = await client.getProductVariations(wc.id)
            } catch {
              // proceed with no variations
            }
          }

          const categoryIds = wc.categories
            .map((c) => state.wcToNymbalCategory[c.id])
            .filter((id): id is string => Boolean(id))

          const slug = wc.slug || wc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
          const suffix = seenSlugs.has(slug) ? String(wc.id) : ''
          seenSlugs.add(slug)

          const mediaItems = await downloadProductImages(wc.images, slug, storage)

          try {
            const snap = await services.product.create(
              mapProduct(wc, variations, categoryIds, mediaItems, suffix),
            )
            state.wcToNymbalProduct[wc.id] = snap.id
            state.importedIds.products.push(snap.id)
            state.eventsEmitted++
          } catch (err) {
            state.errors.push({ phase: 'products', id: String(wc.id), error: String(err) })
          }
        },
        opts.concurrency,
      )

      done += page.items.length
      emit({ kind: 'progress', entity: 'products', done, total })
      state.cursors['products'] = { page: (state.cursors['products']?.page ?? 1) + 1 }
      await checkpoint()
    }
  }

  // ── 4. Customers ─────────────────────────────────────────────────────────────
  if (opts.entities.includes('customers') && state.phase !== 'done') {
    emit({ kind: 'phase', phase: 'customers' })
    state.phase = 'customers'

    const startPage = state.cursors['customers']?.page ?? 1
    let done = state.importedIds.customers.length
    let total = 0

    for await (const page of client.paginate<WcCustomer>('/customers', {}, startPage)) {
      total = page.total

      await pMap(
        page.items,
        async (wc) => {
          if (state.wcToNymbalCustomer[wc.id]) return
          try {
            const customer = await services.auth.importCustomer(mapCustomer(wc, opts.gdpr))
            state.wcToNymbalCustomer[wc.id] = customer.id
            state.importedIds.customers.push(customer.id)
            state.eventsEmitted++
          } catch (err) {
            state.errors.push({ phase: 'customers', id: String(wc.id), error: String(err) })
          }
        },
        opts.concurrency,
      )

      done += page.items.length
      emit({ kind: 'progress', entity: 'customers', done, total })
      state.cursors['customers'] = { page: (state.cursors['customers']?.page ?? 1) + 1 }
      await checkpoint()
    }
  }

  // ── 5. Orders ────────────────────────────────────────────────────────────────
  if (opts.entities.includes('orders') && state.phase !== 'done') {
    emit({ kind: 'phase', phase: 'orders' })
    state.phase = 'orders'

    const startPage = state.cursors['orders']?.page ?? 1
    let done = state.importedIds.orders.length
    let total = 0

    for await (const page of client.paginate<WcOrder>('/orders', {}, startPage)) {
      total = page.total

      await pMap(
        page.items,
        async (wc) => {
          if (state.wcToNymbalProduct[wc.id]) return
          const nymbalCustomerId = wc.customer_id
            ? (state.wcToNymbalCustomer[wc.customer_id] ?? null)
            : null
          const productIdMap: Record<number, string> = {}
          for (const li of wc.line_items) {
            const nid = state.wcToNymbalProduct[li.product_id]
            if (nid) productIdMap[li.product_id] = nid
          }
          try {
            const order = await services.order.importOrder(
              mapOrder(wc, nymbalCustomerId, productIdMap, opts.currency),
            )
            state.importedIds.orders.push(order.id)
            state.eventsEmitted++
          } catch (err) {
            state.errors.push({ phase: 'orders', id: String(wc.id), error: String(err) })
          }
        },
        opts.concurrency,
      )

      done += page.items.length
      emit({ kind: 'progress', entity: 'orders', done, total })
      state.cursors['orders'] = { page: (state.cursors['orders']?.page ?? 1) + 1 }
      await checkpoint()
    }
  }

  // ── 6. Reviews ───────────────────────────────────────────────────────────────
  if (opts.entities.includes('reviews') && state.phase !== 'done') {
    emit({ kind: 'phase', phase: 'reviews' })
    state.phase = 'reviews'

    const startPage = state.cursors['reviews']?.page ?? 1
    let done = state.importedIds.reviews.length
    let total = 0

    for await (const page of client.paginate<WcReview>('/products/reviews', {}, startPage)) {
      total = page.total

      for (const wc of page.items) {
        const nymbalProductId = state.wcToNymbalProduct[wc.product_id]
        if (!nymbalProductId) continue
        try {
          const result = await adapters.reviews.submitReview(
            mapReview(wc, nymbalProductId, null),
          )
          state.importedIds.reviews.push(result.review.id)
          state.eventsEmitted++
        } catch (err) {
          state.errors.push({ phase: 'reviews', id: String(wc.id), error: String(err) })
        }
        done++
        emit({ kind: 'progress', entity: 'reviews', done, total })
      }

      state.cursors['reviews'] = { page: (state.cursors['reviews']?.page ?? 1) + 1 }
      await checkpoint()
    }
  }

  // ── 7. AI Enrichment ─────────────────────────────────────────────────────────
  const enrichStats = { enriched: 0, skipped: 0, failed: 0 }
  if (opts.ai && state.importedIds.products.length > 0) {
    emit({ kind: 'phase', phase: 'enrich' })
    const stats = await runEnrichment(
      state.importedIds.products,
      adapters.ai,
      services.product,
      (done, total) => emit({ kind: 'progress', entity: 'enrichment', done, total }),
    )
    Object.assign(enrichStats, stats)
    state.eventsEmitted += enrichStats.enriched
  }

  state.phase = 'done'
  await checkpoint()

  const report = buildReport(state, startMs)
  report.enriched = enrichStats
  return report
}
