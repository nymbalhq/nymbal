import { randomUUID } from 'node:crypto'
import type { Logger, SearchAdapter, SearchDocument } from '@nymbalhq/types'
import { toIndexRow } from '../../../../../platform/src/adapters/search/terms.js'
import { createAdapter } from '../index.js'
import type { RecordedRequest } from './fake-algolia.js'

// What the adapter's own tests share: an adapter on a host (the fake, or a server that never answers), a logger that
// keeps what it was told, a product document as buildSearchDoc makes one, and the terms native's index gives it.

/** The longest term the adapter sends or stores, in characters. */
export const MAX_TERM = 480

export interface AlgoliaConfig {
  appId: string
  apiKey: string
  indexName: string
  host: string
}

export interface Captured {
  logger: Logger
  /** Every line logged at warn, each as the JSON of its object and message. */
  warnings: string[]
}

export function capturingLogger(): Captured {
  const warnings: string[] = []
  const logger: Logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (obj: unknown, msg?: string) => void warnings.push(JSON.stringify({ obj, msg })),
    error: () => undefined,
    child: () => logger,
  }
  return { logger, warnings }
}

export function algoliaConfig(host: string, overrides: Partial<AlgoliaConfig> = {}): AlgoliaConfig {
  return {
    appId: 'FAKEAPP',
    apiKey: 'fake-admin-key',
    indexName: `products-${randomUUID().slice(0, 8)}`,
    host,
    ...overrides,
  }
}

/** The adapter as the kernel makes it: createAdapter with the slot's config block; initialized unless told not to. */
export async function adapterOn(
  config: AlgoliaConfig,
  opts: { logger?: Logger; initialize?: boolean } = {},
): Promise<SearchAdapter> {
  const adapter = (await createAdapter({
    slot: 'search',
    config: { ...config },
    logger: opts.logger ?? capturingLogger().logger,
    env: {},
  })) as SearchAdapter
  if (opts.initialize !== false) await adapter.initialize({ ...config })
  return adapter
}

export interface ProductInit {
  name: string
  description?: string
  status?: string
  categoryIds?: string[]
  variants?: Array<{ sku: string; name: string; priceMinor: number }>
}

/** A product's search document, in buildSearchDoc's shape. */
export function productDoc(id: string, init: ProductInit): SearchDocument {
  return {
    id,
    type: 'product',
    fields: {
      slug: `slug-${id}`,
      name: init.name,
      description: init.description ?? '',
      status: init.status ?? 'active',
      categoryIds: init.categoryIds ?? [],
      variants: init.variants ?? [],
    },
  }
}

/** Native's terms for the document, in native's order (name, each variant's SKU and name, description), each capped
 *  at MAX_TERM, the first of each kept. */
export function nativeTerms(doc: SearchDocument): string[] {
  const row = toIndexRow(doc)
  return [...new Set([...row.name, ...row.strong, ...row.body].map((t) => t.slice(0, MAX_TERM)))]
}

/** The `query` values a recorded search request sent, from its JSON body or its `params` string (one per search of a
 *  multi-query). */
export function sentQueries(request: RecordedRequest): string[] {
  const one = (body: { query?: unknown; params?: unknown } | null): string[] => {
    if (typeof body?.query === 'string') return [body.query]
    if (typeof body?.params === 'string') {
      const q = new URLSearchParams(body.params).get('query')
      return q === null ? [] : [q]
    }
    return []
  }
  const body = request.body as { requests?: unknown } | null
  return Array.isArray(body?.requests)
    ? (body.requests as Array<{ query?: unknown; params?: unknown }>).flatMap(one)
    : one(request.body as { query?: unknown; params?: unknown } | null)
}

export const isSearchRequest = (r: RecordedRequest): boolean =>
  r.method === 'POST' && (/\/query$/.test(r.path) || r.path === '/1/indexes/*/queries')

export const isBatchRequest = (r: { method: string; path: string }): boolean =>
  r.method === 'POST' && /\/batch$/.test(r.path)
