import type { AiAdapter, MediaStorage } from '@nymbalhq/types'
import type {
  ServiceRegistry,
  Repositories,
} from '@nymbalhq/platform'
import type {
  WooCommerceImportOptions,
  ImportEntity,
  ImportState,
  ProgressCallback,
} from '../types.js'
import { appendJournal, compactState, freshState, loadState, saveState } from '../state.js'
import { buildReport } from '../report.js'
import { WooCommerceClient, WooCommerceApiError } from './client.js'
import type { WcCategory, WcProduct, WcVariation, WcCustomer, WcOrder, WcReview } from './client.js'
import { mapCategory } from './mappers/category.js'
import { mapProduct, productSlug } from './mappers/product.js'
import { mapCustomer } from './mappers/customer.js'
import { mapOrder } from './mappers/order.js'
import { mapReview } from './mappers/review.js'
import { downloadProductImages, type ImagePolicy } from './media.js'
import { runEnrichment } from './enrichment.js'
import { categoryRefs, orderRefs, productRefs, reviewRefs } from './refs.js'
import type { ReviewsAdapter } from '@nymbalhq/types'

export interface WooCommerceImporterDeps {
  services: ServiceRegistry
  repos: Repositories
  /** `ai` is null when the store's ai provider is `none`, and enrichment is skipped. */
  adapters: { ai: AiAdapter | null; reviews: ReviewsAdapter }
  /** The store's media storage (`app.platform.media`): every product image is put here. */
  media: MediaStorage
  /** Resolves an image host to its addresses for the image policy; the system resolver by default. */
  lookup?: ImagePolicy['lookup']
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
  const { services, adapters, media, onProgress } = deps
  const emit = onProgress ?? (() => undefined)

  const client = new WooCommerceClient(opts.credentials)
  // The store's own host is fetched whatever its address; a URL that does not parse fails at the connect check below.
  const imagePolicy: ImagePolicy = {
    ...(URL.canParse(opts.credentials.url) && {
      allowHost: new URL(opts.credentials.url).hostname,
    }),
    ...(deps.lookup !== undefined && { lookup: deps.lookup }),
  }

  // A state that cannot be read throws here: starting again would forget what earlier runs created. `--fresh` starts
  // the progress again but keeps the records earlier runs created, so a rollback still removes them.
  const saved = await loadState(opts.statePath)
  const state: ImportState =
    saved === null
      ? freshState()
      : opts.fresh
        ? { ...freshState(), importedIds: saved.importedIds, rollbackSince: saved.rollbackSince }
        : saved

  const checkpoint = async () => saveState(opts.statePath, state)
  const journal = (entity: ImportEntity, id: string, wcId: number) =>
    appendJournal(opts.statePath, { entity, id, wcId })

  // ── 1. Connect ──────────────────────────────────────────────────────────────
  emit({ kind: 'phase', phase: 'connect' })
  try {
    await client.healthCheck()
  } catch (err) {
    if (err instanceof WooCommerceApiError) throw err
    throw new Error(`Cannot connect to ${opts.credentials.url}: ${String(err)}`)
  }

  // On disk before the first create, so a run stopped at any point can be rolled back from the files alone.
  await compactState(opts.statePath, state)

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
        const { parentWcId } = categoryRefs(wc)
        const nymbalParentId = parentWcId ? state.wcToNymbalCategory[parentWcId] : undefined
        try {
          const category = await services.category.create(mapCategory(wc, nymbalParentId))
          state.wcToNymbalCategory[wc.id] = category.id
          state.importedIds.categories.push(category.id)
          state.eventsEmitted++
          await journal('categories', category.id, wc.id)
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
          // Before the skip, so a product created before a stop still claims its slug on resume.
          const refs = productRefs(wc, seenSlugs)
          if (state.wcToNymbalProduct[wc.id]) return

          let variations: WcVariation[] = []
          if (refs.isVariable && refs.variationCount > 0) {
            try {
              variations = await client.getProductVariations(wc.id)
            } catch {
              // proceed with no variations
            }
          }

          const categoryIds = refs.categoryWcIds
            .map((id) => state.wcToNymbalCategory[id])
            .filter((id): id is string => Boolean(id))

          const mediaItems = await downloadProductImages(
            refs.imageSources,
            productSlug(wc, refs.slugSuffix),
            media,
            (err) => {
              state.errors.push({ phase: 'media', id: String(wc.id), error: String(err) })
              emit({ kind: 'error', phase: 'media', id: String(wc.id), message: String(err) })
            },
            imagePolicy,
          )

          try {
            const snap = await services.product.create(
              mapProduct(wc, variations, categoryIds, mediaItems, refs.slugSuffix),
            )
            state.wcToNymbalProduct[wc.id] = snap.id
            state.importedIds.products.push(snap.id)
            state.eventsEmitted++
            await journal('products', snap.id, wc.id)
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
            // A customer whose email the store already had is returned as it was: its orders attach to it, but it is
            // the store's, so a rollback leaves it.
            const woo = customer.metadata['woocommerce'] as { customerId?: unknown } | undefined
            if (woo?.customerId !== wc.id) return
            state.importedIds.customers.push(customer.id)
            state.eventsEmitted++
            await journal('customers', customer.id, wc.id)
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
          if (state.wcToNymbalOrder[wc.id]) return
          const { customerWcId, lineProductWcIds } = orderRefs(wc)
          const nymbalCustomerId = customerWcId
            ? (state.wcToNymbalCustomer[customerWcId] ?? null)
            : null
          const productIdMap: Record<number, string> = {}
          for (const productWcId of lineProductWcIds) {
            const nid = state.wcToNymbalProduct[productWcId]
            if (nid) productIdMap[productWcId] = nid
          }
          try {
            const order = await services.order.importOrder(
              mapOrder(wc, nymbalCustomerId, productIdMap, opts.currency),
            )
            state.wcToNymbalOrder[wc.id] = order.id
            state.importedIds.orders.push(order.id)
            state.eventsEmitted++
            await journal('orders', order.id, wc.id)
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
        if (state.wcToNymbalReview[wc.id]) continue
        const nymbalProductId = state.wcToNymbalProduct[reviewRefs(wc).productWcId]
        if (!nymbalProductId) continue
        try {
          const result = await adapters.reviews.submitReview(
            mapReview(wc, nymbalProductId, null),
          )
          state.wcToNymbalReview[wc.id] = result.review.id
          state.importedIds.reviews.push(result.review.id)
          state.eventsEmitted++
          await journal('reviews', result.review.id, wc.id)
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
  if (opts.ai && adapters.ai !== null && state.importedIds.products.length > 0) {
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
