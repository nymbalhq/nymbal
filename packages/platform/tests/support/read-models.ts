import type { SearchAdapter, SearchDocument } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { rebuild, type RebuildDeps, type RebuildReport } from '../../src/read-models/index.js'
import type { Kernel } from './kernel.js'
import { openRaw } from './raw.js'
import { ALL_MODELS, documentModelsOf } from './read-model-shapes.js'

export {
  ALL_MODELS,
  DOCUMENT_COLLECTIONS,
  DOCUMENT_MODELS,
  collectionOf,
  documentModelsOf,
} from './read-model-shapes.js'

// P3-02 (spec P3-02-replay-engine) support: what the replay acceptance suites share. The read models and their
// collections (read-model-shapes.ts), a search index that records what it is given, the native index's rows as a second connection
// reads them, and the rebuild deps of a kernel. Nothing here knows how the rebuilders are implemented.

export interface RecordingSearch extends SearchAdapter {
  /** What the index holds now, by id. */
  documents(): SearchDocument[]
}

async function* each<T>(docs: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  for await (const doc of docs) yield doc
}

/**
 * A search index that keeps what it is given in memory: `replaceAll` replaces it, `index` upserts by id, `remove`
 * deletes. It answers no queries; the suites read `documents()`.
 */
export function recordingSearch(): RecordingSearch {
  let held = new Map<string, SearchDocument>()
  return {
    kind: 'search',
    providerName: 'p3-02-recording',
    capabilities: () => ['index'],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' }),
    async index(documents) {
      for (const doc of documents) held.set(doc.id, doc)
      return { indexed: documents.length }
    },
    async remove(ids) {
      for (const id of ids) held.delete(id)
    },
    async replaceAll(docs: Iterable<SearchDocument> | AsyncIterable<SearchDocument>) {
      const next = new Map<string, SearchDocument>()
      for await (const doc of each(docs)) next.set(doc.id, doc)
      held = next
    },
    async search() {
      return { items: [], total: 0, nextCursor: null }
    },
    async facet(field) {
      return { field, label: field, values: [] }
    },
    documents() {
      return [...held.values()].sort((a, b) => a.id.localeCompare(b.id))
    },
  } as RecordingSearch
}

/** The native index's documents (migration 0007's `search_documents`), read by a second connection, by id. */
export async function nativeSearchDocuments(k: Kernel): Promise<SearchDocument[]> {
  const raw = openRaw(k.dialect, k.target)
  try {
    const rows = await raw.rows<{ id: string; type: string; fields: unknown }>(
      'SELECT id, type, fields FROM search_documents ORDER BY id',
    )
    return rows
      .map((r) => ({
        id: String(r.id),
        type: String(r.type),
        fields: (typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields) as Record<
          string,
          unknown
        >,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  } finally {
    await raw.close()
  }
}

/** The rebuild deps of a kernel: its store, repositories, config and logger, writing to its own read models unless `over` says otherwise. */
export function rebuildDeps(k: Kernel, over: Partial<RebuildDeps> = {}): RebuildDeps {
  return {
    config: k.config,
    store: k.store,
    repos: k.repos,
    documentStore: k.documentStore,
    search: k.app.adapters.search,
    logger: k.logger,
    ...over,
  }
}

/** A rebuild of every read model into a fresh in-memory document store and a recording index, with its report. */
export async function rebuildFresh(
  k: Kernel,
  over: Partial<RebuildDeps> = {},
): Promise<{
  documents: Record<string, unknown[]>
  search: SearchDocument[]
  report: RebuildReport
}> {
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const search = recordingSearch()
  try {
    const report = await rebuild(ALL_MODELS, rebuildDeps(k, { documentStore, search, ...over }))
    return { documents: await documentModelsOf(documentStore), search: search.documents(), report }
  } finally {
    await documentStore.close()
  }
}

/** How many times a rebuild of every model calls `onPage` on this kernel's data now (into a scratch target). */
export async function pagesOf(k: Kernel, pageSize: number): Promise<number> {
  let calls = 0
  await rebuildFresh(k, {
    pageSize,
    onPage: async () => {
      calls += 1
    },
  })
  return calls
}

/** A promise and the function that resolves it. */
export function gate(): { opened: Promise<void>; open(): void } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}
