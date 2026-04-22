import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_UPDATED,
  type DocumentStoreAdapter,
  type FacetResult,
  type IndexResult,
  type Logger,
  type SearchAdapter,
  type SearchDocument,
  type SearchResult,
} from '@nymbal/types'
import { noopInitialize, okHealth } from '../base.js'

const INDEX_COLLECTION = 'search-index'

interface IndexedDoc {
  id: string
  type: string
  fields: Record<string, unknown>
  text: string
}

function flatten(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) return value.map(flatten).join(' ')
  if (typeof value === 'object') {
    return Object.values(value).map(flatten).join(' ')
  }
  return ''
}

export function createNativeSearchAdapter(deps: {
  documentStore: DocumentStoreAdapter
  logger: Logger
}): SearchAdapter {
  const { documentStore, logger } = deps
  return {
    kind: 'search',
    providerName: 'native',
    capabilities: ['index', 'search', 'facet'],
    producesEvents: [],
    consumesEvents: [EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED, EVT_PRODUCT_DELETED],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),

    async index(documents) {
      const entries = new Map<string, IndexedDoc>()
      for (const doc of documents) {
        entries.set(doc.id, {
          id: doc.id,
          type: doc.type,
          fields: doc.fields,
          text: flatten(doc.fields).toLowerCase(),
        })
      }
      await documentStore.batchPut(INDEX_COLLECTION, entries)
      logger.debug({ count: documents.length }, 'search.index')
      return { indexed: documents.length } satisfies IndexResult
    },

    async remove(ids) {
      for (const id of ids) {
        await documentStore.delete(INDEX_COLLECTION, id)
      }
    },

    async search(query, params) {
      const q = query.trim().toLowerCase()
      const limit = params?.limit ?? 20
      const result = await documentStore.query<IndexedDoc>(INDEX_COLLECTION, {
        partitionKey: { field: 'type', value: 'product' },
        limit: 1000,
      })
      const filtered = result.items.filter((item) => {
        if (!q) return true
        if (!item.text.includes(q)) return false
        for (const [k, v] of Object.entries(params?.filters ?? {})) {
          const field = (item.fields as Record<string, unknown>)[k]
          if (field !== v) return false
        }
        return true
      })
      return {
        items: filtered.slice(0, limit).map((it) => ({
          id: it.id,
          type: it.type,
          fields: it.fields,
        })),
        total: filtered.length,
        nextCursor: null,
      } satisfies SearchResult
    },

    async facet(field) {
      const result = await documentStore.query<IndexedDoc>(INDEX_COLLECTION, {
        partitionKey: { field: 'type', value: 'product' },
        limit: 1000,
      })
      const counts = new Map<string, number>()
      for (const item of result.items) {
        const raw = (item.fields as Record<string, unknown>)[field]
        if (raw == null) continue
        const values = Array.isArray(raw) ? raw : [raw]
        for (const v of values) {
          const key = String(v)
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
      return {
        field,
        buckets: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([value, count]) => ({ value, count })),
      } satisfies FacetResult
    },
  }
}
