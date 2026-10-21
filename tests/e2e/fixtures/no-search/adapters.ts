// P2-09 decision 6: the no-search store's search adapter, injected through the config's `adapters` export into the
// `custom` search slot. It offers nothing (`capabilities()` is `[]`), so GET /api/capabilities reports search without
// `search` and the templates' header renders no search bar. It still takes the documents the kernel indexes, so the
// projections that call it run as they do on any store. Self-contained on purpose, as the custom-providers fixture is:
// nothing from @nymbalhq/platform (jiti would load a second instance of it) and no runtime import from @nymbalhq/types.

export type Health = { status: 'healthy' | 'degraded' | 'down'; detail?: string }

export interface Doc {
  id: string
  type: string
  fields: Record<string, unknown>
}

/** What the no-search store's search offers: nothing. */
export const NO_SEARCH_CAPABILITIES: readonly string[] = []

export function createNoSearchAdapter() {
  const docs = new Map<string, Doc>()
  return {
    kind: 'search' as const,
    providerName: 'p2-09-no-search',
    capabilities: (): readonly string[] => [...NO_SEARCH_CAPABILITIES],
    producesEvents: [] as readonly string[],
    consumesEvents: [] as readonly string[],
    initialize: async (_config: unknown): Promise<void> => undefined,
    healthCheck: async (): Promise<Health> => ({ status: 'healthy' }),

    async index(documents: Doc[]): Promise<{ indexed: number }> {
      for (const doc of documents) docs.set(doc.id, doc)
      return { indexed: documents.length }
    },

    async remove(documentIds: string[]): Promise<void> {
      for (const id of documentIds) docs.delete(id)
    },

    // Not offered: the interface has the method, and it finds nothing.
    async search(
      _query: string,
      _params?: { limit?: number; cursor?: string; filters?: Record<string, unknown> },
    ): Promise<{ items: Doc[]; total: number; nextCursor: string | null }> {
      return { items: [], total: 0, nextCursor: null }
    },

    async facet(
      field: string,
    ): Promise<{ field: string; label: string; values: Array<{ value: string }> }> {
      return { field, label: field, values: [] }
    },
  }
}
