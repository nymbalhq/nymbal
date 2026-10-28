import {
  EVT_CUSTOMER_DELETED,
  EVT_PRODUCT_VIEWED,
  EVT_VISITOR_MERGED,
  type CustomerDeletedV1Payload,
  type DocumentStoreAdapter,
  type NymbalEvent,
  type ProductViewedV1Payload,
  type RecentViewer,
  type VisitorMergedV1Payload,
} from '@nymbalhq/types'
import { recentlyViewedProjection } from '../handlers/projections/recently-viewed-projection.js'
import type { Repositories } from '../repositories/index.js'
import { PRODUCTS, RECENTLY_VIEWED, type DenormalisedProduct } from './builders.js'
import type { ReadModel } from './model.js'

export { RECENTLY_VIEWED }

/** How many products a viewer's list holds. */
export const RECENT_VIEWS_KEPT = 12

/** How far back a list reaches, whatever the event log keeps beyond it. */
export const RECENT_VIEWS_WINDOW_DAYS = 30

export const RECENTLY_VIEWED_TYPES = [
  EVT_PRODUCT_VIEWED,
  EVT_VISITOR_MERGED,
  EVT_CUSTOMER_DELETED,
] as const

export interface RecentlyViewedDoc {
  viewer: string
  items: Array<{ productId: string; viewedAt: string }>
}

export function viewerKey(v: RecentViewer): string {
  return `${v.kind}:${v.id}`
}

type Item = RecentlyViewedDoc['items'][number]

const newestFirst = (a: Item, b: Item): number =>
  a.viewedAt === b.viewedAt
    ? a.productId < b.productId
      ? -1
      : a.productId > b.productId
        ? 1
        : 0
    : a.viewedAt < b.viewedAt
      ? 1
      : -1

/**
 * Each product once at its newest view, newest first, the first `RECENT_VIEWS_KEPT`: a max-merge truncated by rank,
 * so the same views in any order, any number of times, give the same list.
 */
function ranked(items: Iterable<Item>): Item[] {
  const newest = new Map<string, string>()
  for (const { productId, viewedAt } of items) {
    const held = newest.get(productId)
    if (held === undefined || viewedAt > held) newest.set(productId, viewedAt)
  }
  return [...newest]
    .map(([productId, viewedAt]) => ({ productId, viewedAt }))
    .sort(newestFirst)
    .slice(0, RECENT_VIEWS_KEPT)
}

export function withView(
  doc: RecentlyViewedDoc | null,
  viewer: string,
  productId: string,
  viewedAt: string,
): RecentlyViewedDoc {
  return { viewer, items: ranked([...(doc?.items ?? []), { productId, viewedAt }]) }
}

/** The visitor's views folded into the customer's list, as the cart merge folds a guest cart; null when neither has one. */
export function merged(
  visitor: RecentlyViewedDoc | null,
  customer: RecentlyViewedDoc | null,
  customerKey: string,
): RecentlyViewedDoc | null {
  if (visitor === null) return customer
  if (customer === null) return { viewer: customerKey, items: visitor.items }
  return { viewer: customerKey, items: ranked([...customer.items, ...visitor.items]) }
}

/** Where a fold reads and writes viewers' documents: the document store live, a map in a rebuild. */
export interface ViewerDocuments {
  get(key: string): Promise<RecentlyViewedDoc | null>
  put(key: string, doc: RecentlyViewedDoc): Promise<void>
  delete(key: string): Promise<void>
}

/** Applies one view, merge or customer deletion to the documents it touches. */
export async function foldEvent(docs: ViewerDocuments, event: NymbalEvent<unknown>): Promise<void> {
  if (event.type === EVT_PRODUCT_VIEWED) {
    const { productId, viewer } = event.payload as ProductViewedV1Payload
    const key = viewerKey(viewer)
    await docs.put(key, withView(await docs.get(key), key, productId, event.timestamp))
  } else if (event.type === EVT_VISITOR_MERGED) {
    const { visitorId, customerId } = event.payload as VisitorMergedV1Payload
    const visitorKey = viewerKey({ kind: 'visitor', id: visitorId })
    const customerKey = viewerKey({ kind: 'customer', id: customerId })
    const next = merged(await docs.get(visitorKey), await docs.get(customerKey), customerKey)
    if (next !== null) await docs.put(customerKey, next)
    await docs.delete(visitorKey)
  } else if (event.type === EVT_CUSTOMER_DELETED) {
    const { customerId } = event.payload as CustomerDeletedV1Payload
    await docs.delete(viewerKey({ kind: 'customer', id: customerId }))
  }
}

export interface ReadRecentlyViewedDeps {
  documentStore: DocumentStoreAdapter
  repos: Pick<Repositories, 'product'>
  retentionDays: number
  now: () => Date
}

/**
 * The viewer's products as `GET /api/products/:slug` serves them, newest first: only those whose row is active now,
 * viewed within `min(RECENT_VIEWS_WINDOW_DAYS, retentionDays)` days, since a rebuild can only reproduce what the log
 * still holds.
 */
export async function readRecentlyViewed(
  deps: ReadRecentlyViewedDeps,
  viewer: string | null,
): Promise<DenormalisedProduct[]> {
  if (viewer === null) return []
  const doc = await deps.documentStore.get<RecentlyViewedDoc>(RECENTLY_VIEWED, viewer)
  if (doc === null) return []
  const days = Math.min(RECENT_VIEWS_WINDOW_DAYS, deps.retentionDays)
  const since = new Date(deps.now().getTime() - days * 86_400_000).toISOString()
  const recent = doc.items.filter((i) => i.viewedAt >= since)
  const { product } = deps.repos
  const slugs = await product.store.read(async (tx) => {
    const out: string[] = []
    for (const { productId } of recent) {
      const row = await product.findById(tx, productId)
      if (row?.status === 'active') out.push(row.slug)
    }
    return out
  })
  const docs = await deps.documentStore.batchGet<DenormalisedProduct>(PRODUCTS, slugs)
  return slugs.flatMap((slug) => {
    const found = docs.get(slug)
    return found === undefined ? [] : [found]
  })
}

/** Rebuilt from the events log, the only record of a view, through the fold the live projection runs. */
export const recentlyViewed: ReadModel = {
  name: 'recently-viewed',
  target: 'documents',
  collections: [RECENTLY_VIEWED],

  async *rebuild(ctx) {
    const held = new Map<string, RecentlyViewedDoc>()
    const docs: ViewerDocuments = {
      get: async (key) => held.get(key) ?? null,
      put: async (key, doc) => {
        held.set(key, doc)
      },
      delete: async (key) => {
        held.delete(key)
      },
    }
    for await (const page of ctx.events(RECENTLY_VIEWED_TYPES)) {
      for (const { event } of page) await foldEvent(docs, event)
    }
    for (const [key, doc] of held) yield { collection: RECENTLY_VIEWED, key, doc }
  },

  handlers({ documentStore, logger }) {
    return recentlyViewedProjection({ documentStore, logger })
  },
}
