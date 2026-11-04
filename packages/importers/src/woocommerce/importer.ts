import type { AiAdapter, MediaStorage, Order, ProductSnapshot } from '@nymbalhq/types'
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
import {
  appendJournal,
  compactState,
  ENTITIES,
  freshState,
  loadState,
  saveState,
  warningAdder,
} from '../state.js'
import { buildReport } from '../report.js'
import { PAGE_SIZE, WooCommerceClient, WooCommerceApiError } from './client.js'
import type {
  WcCategory,
  WcProduct,
  WcVariation,
  WcCustomer,
  WcOrder,
  WcReview,
  WcStoreSettings,
} from './client.js'
import { mapCategory } from './mappers/category.js'
import { mapProduct, productSlug, productWarnings, type StoreContext } from './mappers/product.js'
import { mapCustomer } from './mappers/customer.js'
import { mapOrder } from './mappers/order.js'
import { mapReview } from './mappers/review.js'
import { downloadProductImages, type ImagePolicy } from './media.js'
import { runEnrichment } from './enrichment.js'
import { categoryRefs, orderRefs, productRefs, reviewRefs } from './refs.js'
import { NotFoundError, type ReviewsAdapter } from '@nymbalhq/types'
import { applyProductChanges, deltaParams, ImportSinceError } from './delta.js'

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

/**
 * Wraps a pMap callback so each call can wait, with `earlierDone`, until every call started before it has finished.
 * Calls start in item order, so the waits run in that order whatever the concurrency.
 */
function sourceOrder<T>() {
  let last: Promise<void> = Promise.resolve()
  return <U>(fn: (item: T, earlierDone: () => Promise<void>) => Promise<U>) =>
    async (item: T): Promise<U> => {
      const previous = last
      let release!: () => void
      last = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        return await fn(item, () => previous)
      } finally {
        void previous.then(release)
      }
    }
}

export const DEFAULT_UNTRACKED_STOCK = 1000

/** Why a store in another currency than the WooCommerce store's is refused, before anything is written. */
export function currencyRefusal(sourceCurrency: string, storeCurrency: string): string {
  return `The WooCommerce store prices in ${sourceCurrency} and this store in ${storeCurrency}: nothing was imported. Import into a store whose currency is ${sourceCurrency}.`
}

/** WooCommerce's own defaults stand in for settings the import cannot read: kg, cm and a low-stock amount of 2. */
export function storeContextFor(
  settings: WcStoreSettings | null,
  currency: string,
  untrackedStock: number,
): StoreContext {
  return settings === null
    ? { currency, weightUnit: 'kg', dimensionUnit: 'cm', lowStockAmount: 2, untrackedStock }
    : { ...settings, untrackedStock }
}

/**
 * One entity's progress: every source record this run passes counts, whatever became of it, from the records the pages
 * before the cursor held. A source that lost records since an earlier run can hold fewer than that, so `done` never
 * shows past the total.
 */
function progressOf(entity: ImportEntity, startPage: number, emit: ProgressCallback) {
  let passed = PAGE_SIZE * (startPage - 1)
  let total = 0
  return {
    page(pageTotal: number) {
      total = pageTotal
    },
    pass(records: number) {
      passed += records
      emit({ kind: 'progress', entity, done: Math.min(passed, total), total })
    },
  }
}

/** Nymbal variant ids by the WooCommerce variation (or simple product) id each was made from. */
function variantIdsOf(product: ProductSnapshot): Record<number, string> {
  const woo = product.metadata['woocommerce'] as
    | { variants?: Record<string, { id?: unknown }> }
    | undefined
  const out: Record<number, string> = {}
  for (const variant of product.variants) {
    const wcId = woo?.variants?.[variant.sku]?.id
    if (typeof wcId === 'number') out[wcId] = variant.id
  }
  return out
}

export async function runWooCommerceImport(
  opts: WooCommerceImportOptions,
  deps: WooCommerceImporterDeps,
) {
  const untrackedStock = opts.untrackedStock ?? DEFAULT_UNTRACKED_STOCK
  if (!Number.isInteger(untrackedStock) || untrackedStock < 0) {
    throw new Error(`untrackedStock must be a whole number of 0 or more, not ${untrackedStock}`)
  }
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
  if (opts.since !== undefined) {
    if (opts.fresh) {
      throw new ImportSinceError('fresh', '--since cannot be combined with --fresh, which starts the import again')
    }
    if (saved === null) {
      throw new ImportSinceError(
        'no-state',
        `--since needs the state of a finished import, and ${opts.statePath} is absent`,
      )
    }
    if (saved.phase !== 'done') {
      throw new ImportSinceError(
        'not-finished',
        'The last import has not finished: run nymbal import to finish it before --since',
      )
    }
  }
  const state: ImportState =
    saved === null
      ? freshState()
      : opts.fresh
        ? { ...freshState(), importedIds: saved.importedIds, rollbackSince: saved.rollbackSince }
        : saved
  if (opts.since !== undefined) {
    // A delta is a pass of its own: every selected entity from its first page, filtered by when it changed.
    state.delta = {
      since: opts.since,
      startedAt: new Date().toISOString(),
      updated: { products: 0 },
      changedNotUpdated: { orders: 0 },
      created: { products: [] },
    }
    state.phase = 'connect'
    state.cursors = {}
    state.finished = []
  }
  const since = state.delta?.since

  const runs = (entity: ImportEntity) =>
    opts.entities.includes(entity) && !state.finished.includes(entity)
  // A run that walks no entity, a finished pass's selected ones all finished, reads nothing and records no pass.
  const inPass = state.phase !== 'done' || opts.entities.some(runs)

  const checkpoint = async () => saveState(opts.statePath, state)
  // Saved at once: a run stopped in the next entity still holds this one as covered by the pass.
  const finish = async (entity: ImportEntity) => {
    if (!state.finished.includes(entity)) state.finished.push(entity)
    await checkpoint()
  }
  const journal = (
    entity: ImportEntity,
    id: string,
    wcId: number,
    warnings?: string[],
    mediaWarnings?: string[],
  ) =>
    appendJournal(opts.statePath, {
      entity,
      id,
      wcId,
      ...(warnings && { warnings }),
      ...(mediaWarnings && { mediaWarnings }),
    })
  const warn = warningAdder(state)
  const slugTaken = async (slug: string): Promise<boolean> => {
    try {
      await services.product.getBySlug(slug)
      return true
    } catch (err) {
      if (err instanceof NotFoundError) return false
      throw err
    }
  }

  // ── 1. Connect ──────────────────────────────────────────────────────────────
  emit({ kind: 'phase', phase: 'connect' })
  try {
    await client.healthCheck()
  } catch (err) {
    if (err instanceof WooCommerceApiError) throw err
    throw new Error(`Cannot connect to ${opts.credentials.url}: ${String(err)}`)
  }

  // Prices are copied as they are, so a store in another currency would import wrong money. Codes are compared
  // upper-cased: the platform reads a currency case-insensitively.
  const settings = await client.getStoreSettings()
  if (settings !== null && settings.currency.toUpperCase() !== opts.currency.toUpperCase()) {
    throw new Error(currencyRefusal(settings.currency, opts.currency))
  }
  const store = storeContextFor(settings, opts.currency, untrackedStock)
  if (settings === null) {
    warn({
      phase: 'settings',
      message: `WooCommerce's settings could not be read (a 401 or 403 means the key cannot read them): imported as ${store.currency}, weights in ${store.weightUnit}, sizes in ${store.dimensionUnit} and a low-stock amount of ${store.lowStockAmount}`,
    })
  }

  // On disk before the first create, so a run stopped at any point can be rolled back from the files alone.
  await compactState(opts.statePath, state)

  // ── 2. Categories ────────────────────────────────────────────────────────────
  if (runs('categories')) {
    emit({ kind: 'phase', phase: 'categories' })
    state.phase = 'categories'

    const startPage = state.cursors['categories']?.page ?? 1
    const progress = progressOf('categories', startPage, emit)

    for await (const page of client.paginate<WcCategory>(
      '/products/categories',
      deltaParams('categories', since),
      startPage,
    )) {
      progress.page(page.total)

      for (const wc of page.items) {
        if (state.wcToNymbalCategory[wc.id]) {
          progress.pass(1)
          continue
        }
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
        progress.pass(1)
      }

      state.cursors['categories'] = { page: (state.cursors['categories']?.page ?? 1) + 1 }
      await checkpoint()
    }
    await finish('categories')
  }

  // ── 3. Products ──────────────────────────────────────────────────────────────
  if (runs('products')) {
    emit({ kind: 'phase', phase: 'products' })
    state.phase = 'products'

    const startPage = state.cursors['products']?.page ?? 1
    const progress = progressOf('products', startPage, emit)

    const seenSlugs = new Set<string>()

    for await (const page of client.paginate<WcProduct>(
      '/products',
      deltaParams('products', since),
      startPage,
    )) {
      progress.page(page.total)

      // Images download in parallel, but products are created in source order, as the plan counts them: of two whose
      // slugs clash, the first keeps it whichever finished downloading first.
      const inSourceOrder = sourceOrder<WcProduct>()
      await pMap(
        page.items,
        inSourceOrder(async (wc, earlierCreated) => {
          // Before the skip, so a product created before a stop still claims its slug on resume.
          const refs = productRefs(wc, seenSlugs)
          const imported = state.wcToNymbalProduct[wc.id]
          if (imported && state.delta === undefined) return

          let variations: WcVariation[] = []
          let variationsError: unknown = null
          if (refs.isVariable && refs.variationCount > 0) {
            try {
              variations = await client.getProductVariations(wc.id)
            } catch (err) {
              variationsError = err
            }
          }

          const categoryIds = refs.categoryWcIds
            .map((id) => state.wcToNymbalCategory[id])
            .filter((id): id is string => Boolean(id))

          if (imported && state.delta !== undefined) {
            // With no variations it would map as simple: a false type warning, and its prices never compared.
            if (variationsError !== null) {
              state.errors.push({
                phase: 'products',
                id: String(wc.id),
                error: `WooCommerce product ${wc.id}'s variations could not be read, so it was not updated: ${String(variationsError)}`,
              })
              return
            }
            try {
              const stored = await services.product.getById(imported)
              const changes = await applyProductChanges(wc, variations, categoryIds, stored, {
                product: services.product,
                media,
                imagePolicy,
                store,
              })
              for (const warning of changes.warnings) warn(warning)
              if (changes.mediaError !== null) {
                state.errors.push({
                  phase: 'products',
                  id: String(wc.id),
                  error: changes.mediaError,
                })
              }
              if (changes.written) {
                state.delta.updated.products++
                state.eventsEmitted++
              }
            } catch (err) {
              state.errors.push({ phase: 'products', id: String(wc.id), error: String(err) })
            }
            return
          }

          if (variationsError !== null) {
            // Without its variations it would import as something WooCommerce never sold.
            state.errors.push({
              phase: 'products',
              id: String(wc.id),
              error: `variations could not be read, so the product was not created: ${String(variationsError)}`,
            })
            return
          }

          // A delta reads only what changed, so an earlier product with this slug may not be listed: a slug the store
          // already holds is suffixed, as an import of the whole source suffixes it.
          const slugSuffix =
            state.delta !== undefined &&
            refs.slugSuffix === '' &&
            (await slugTaken(productSlug(wc, '')))
              ? String(wc.id)
              : refs.slugSuffix

          const images = await downloadProductImages(
            refs.imageSources,
            productSlug(wc, slugSuffix),
            media,
            imagePolicy,
          )
          // The store's own media storage refusing a put is an error; a source that did not serve is the merchant's
          // to review, once the product exists.
          for (const failure of images.failed.filter((f) => f.byStorage)) {
            const error = `Image ${failure.src} could not be stored: ${failure.reason}`
            state.errors.push({ phase: 'media', id: String(wc.id), error })
            emit({ kind: 'error', phase: 'media', id: String(wc.id), message: error })
          }

          await earlierCreated()
          try {
            const snap = await services.product.create(
              mapProduct(wc, variations, categoryIds, images.stored, slugSuffix, store),
            )
            const warnings = productWarnings(wc, variations, store)
            const mediaWarnings = images.failed
              .filter((f) => !f.byStorage)
              .map((f) => `Image ${f.src} was not imported (${f.reason}); the product was imported without it`)
            state.wcToNymbalProduct[wc.id] = snap.id
            state.importedIds.products.push(snap.id)
            state.delta?.created.products.push(snap.id)
            for (const message of warnings) warn({ phase: 'products', id: String(wc.id), message })
            for (const message of mediaWarnings) warn({ phase: 'media', id: String(wc.id), message })
            state.eventsEmitted++
            await journal('products', snap.id, wc.id, warnings, mediaWarnings)
          } catch (err) {
            state.errors.push({ phase: 'products', id: String(wc.id), error: String(err) })
          }
        }),
        opts.concurrency,
      )

      progress.pass(page.items.length)
      state.cursors['products'] = { page: (state.cursors['products']?.page ?? 1) + 1 }
      await checkpoint()
    }
    await finish('products')
  }

  // ── 4. Customers ─────────────────────────────────────────────────────────────
  if (runs('customers')) {
    emit({ kind: 'phase', phase: 'customers' })
    state.phase = 'customers'

    const startPage = state.cursors['customers']?.page ?? 1
    const progress = progressOf('customers', startPage, emit)

    for await (const page of client.paginate<WcCustomer>(
      '/customers',
      deltaParams('customers', since),
      startPage,
    )) {
      progress.page(page.total)

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

      progress.pass(page.items.length)
      state.cursors['customers'] = { page: (state.cursors['customers']?.page ?? 1) + 1 }
      await checkpoint()
    }
    await finish('customers')
  }

  // ── 5. Orders ────────────────────────────────────────────────────────────────
  if (runs('orders')) {
    emit({ kind: 'phase', phase: 'orders' })
    state.phase = 'orders'

    const startPage = state.cursors['orders']?.page ?? 1
    const progress = progressOf('orders', startPage, emit)

    const variantCache = new Map<string, Promise<Record<number, string>>>()
    const lineVariants = (productId: string) => {
      let ids = variantCache.get(productId)
      if (ids === undefined) {
        // A product deleted in the store since it was imported has no variants to point at; its lines read 'unknown'.
        ids = services.product.getById(productId).then(variantIdsOf, (err: unknown) => {
          if ((err as { code?: unknown }).code === 'not_found') return {}
          throw err
        })
        variantCache.set(productId, ids)
      }
      return ids
    }

    /**
     * The id of the store's order with this number when it was written from this source order, by a run stopped before
     * its journal line; otherwise the create's own error, or the clash with another order.
     */
    const takeBack = async (orderNumber: string, wcId: number, err: unknown): Promise<string> => {
      let held: Order
      try {
        held = await services.order.getByOrderNumber(orderNumber)
      } catch (lookup) {
        if ((lookup as { code?: unknown }).code === 'not_found') throw err
        throw lookup
      }
      const woo = held.metadata['woocommerce'] as { orderId?: unknown } | undefined
      if (woo?.orderId === wcId) return held.id
      throw new Error(`${orderNumber} is already in the store as another order`)
    }

    for await (const page of client.paginate<WcOrder>(
      '/orders',
      deltaParams('orders', since),
      startPage,
    )) {
      progress.page(page.total)

      await pMap(
        page.items,
        async (wc) => {
          if (state.wcToNymbalOrder[wc.id]) {
            // An imported order is never written again: one a delta lists as changed is counted for the merchant.
            if (state.delta !== undefined) state.delta.changedNotUpdated.orders++
            return
          }
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
            const variantIds: Record<number, string> = {}
            for (const nid of new Set(Object.values(productIdMap))) {
              Object.assign(variantIds, await lineVariants(nid))
            }
            const input = mapOrder(wc, nymbalCustomerId, productIdMap, opts.currency, {
              gdpr: opts.gdpr,
              variantIds,
            })
            let id: string
            try {
              id = (await services.order.importOrder(input)).id
              state.importedIds.orders.push(id)
              state.eventsEmitted++
            } catch (err) {
              id = await takeBack(input.orderNumber, wc.id, err)
              if (!state.importedIds.orders.includes(id)) state.importedIds.orders.push(id)
            }
            state.wcToNymbalOrder[wc.id] = id
            await journal('orders', id, wc.id)
          } catch (err) {
            state.errors.push({ phase: 'orders', id: String(wc.id), error: String(err) })
          }
        },
        opts.concurrency,
      )

      progress.pass(page.items.length)
      state.cursors['orders'] = { page: (state.cursors['orders']?.page ?? 1) + 1 }
      await checkpoint()
    }
    await finish('orders')
  }

  // ── 6. Reviews ───────────────────────────────────────────────────────────────
  if (runs('reviews')) {
    emit({ kind: 'phase', phase: 'reviews' })
    state.phase = 'reviews'

    const startPage = state.cursors['reviews']?.page ?? 1
    const progress = progressOf('reviews', startPage, emit)

    for await (const page of client.paginate<WcReview>(
      '/products/reviews',
      deltaParams('reviews', since),
      startPage,
    )) {
      progress.page(page.total)

      for (const wc of page.items) {
        const nymbalProductId = state.wcToNymbalProduct[reviewRefs(wc).productWcId]
        if (state.wcToNymbalReview[wc.id] || !nymbalProductId) {
          progress.pass(1)
          continue
        }
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
        progress.pass(1)
      }

      state.cursors['reviews'] = { page: (state.cursors['reviews']?.page ?? 1) + 1 }
      await checkpoint()
    }
    await finish('reviews')
  }

  // ── 7. AI Enrichment ─────────────────────────────────────────────────────────
  const enrichStats = { enriched: 0, skipped: 0, failed: 0 }
  // A delta enriches only what it created: an imported product's copy may be the AI's already, reviewed or paid for.
  const toEnrich =
    state.delta === undefined ? state.importedIds.products : state.delta.created.products
  if (opts.ai && adapters.ai !== null && toEnrich.length > 0) {
    emit({ kind: 'phase', phase: 'enrich' })
    const stats = await runEnrichment(
      toEnrich,
      adapters.ai,
      services.product,
      (done, total) => emit({ kind: 'progress', entity: 'enrichment', done, total }),
    )
    Object.assign(enrichStats, stats)
    state.eventsEmitted += enrichStats.enriched
  }

  const delta = state.delta
  const covered = [...state.finished]
  if (inPass) {
    state.runs.push({
      startedAt: delta?.startedAt ?? state.startedAt,
      finishedAt: new Date().toISOString(),
      ...(delta !== undefined && { since: delta.since }),
      entities: covered,
    })
    delete state.delta
  }
  // A delta's pass covers only what it walked; every entity an earlier pass finished stays finished for a plain run.
  if (delta !== undefined) {
    state.finished = ENTITIES.filter((e) => state.runs.some((r) => r.entities.includes(e)))
  }
  state.phase = 'done'
  await checkpoint()

  const report = buildReport(state, startMs)
  report.enriched = enrichStats
  if (delta !== undefined) {
    report.updated = { ...delta.updated }
    report.changedNotUpdated = { ...delta.changedNotUpdated }
    report.since = Object.fromEntries(covered.map((e) => [e, delta.since[e] ?? null]))
  }
  return report
}
