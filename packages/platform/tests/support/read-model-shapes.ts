import type { DocumentStoreAdapter } from '@nymbalhq/types'

// The read models and their document-store collections, and a whole collection read through the adapter's own query
// (a full scan, in key order). Imports nothing of the rebuild, so a suite that only spawns the CLI can use it.

/** Each document-store read model and the collections it owns. `search` owns none of the document store. */
export const DOCUMENT_MODELS = {
  catalogue: ['categories', 'products', 'products-by-category'],
  orders: ['orders', 'orders-by-customer'],
  customers: ['customer-profiles'],
  'recently-viewed': ['recently-viewed'],
} as const

export const ALL_MODELS = ['catalogue', 'orders', 'customers', 'search', 'recently-viewed'] as const

export const DOCUMENT_COLLECTIONS: readonly string[] = Object.values(DOCUMENT_MODELS).flat()

const SCAN_PAGE = 200

/** Every live document of `collection`, in the store's key order (a `'*'` partition scans the collection). */
export async function collectionOf(
  store: DocumentStoreAdapter,
  collection: string,
): Promise<unknown[]> {
  const all: unknown[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10_000; page += 1) {
    const result = await store.query<unknown>(collection, {
      partitionKey: { field: 'id', value: '*' },
      limit: SCAN_PAGE,
      ...(cursor !== undefined && { cursor }),
    })
    all.push(...result.items)
    if (result.nextCursor === null) return all
    cursor = result.nextCursor
  }
  throw new Error(`${collection}: the scan did not end`)
}

/** Every document collection of the read models, by name. */
export async function documentModelsOf(
  store: DocumentStoreAdapter,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const name of DOCUMENT_COLLECTIONS) out[name] = await collectionOf(store, name)
  return out
}
