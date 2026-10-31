// A third party's search adapter, as a store installs it (`commerce.search: { provider: 'acme', package: '@acme/nymbal-search' }`):
// an index in memory that matches a document when every query word is in its name. It declares one secret, `apiKey`,
// read from ACME_SEARCH_KEY, so with none set the kernel gives the slot the not-configured adapter. Every write it is
// asked for is recorded on `globalThis.__acmeSearch.writes`, as [method, ids], so a test reads what reached it.

export const slot = 'search'
export const provider = 'acme'
export const settings = [{ path: 'apiKey', label: 'API key', secret: true, env: 'ACME_SEARCH_KEY' }]

const state = (globalThis.__acmeSearch ??= { writes: [], docs: new Map() })

const wordsOf = (text) =>
  String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? []

export function createAdapter() {
  return {
    kind: 'search',
    providerName: 'acme',
    capabilities: () => ['index', 'search', 'facet'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return { status: 'healthy' }
    },
    async index(documents) {
      state.writes.push(['index', documents.map((d) => d.id)])
      for (const d of documents) state.docs.set(d.id, d)
      return { indexed: documents.length }
    },
    async remove(ids) {
      state.writes.push(['remove', [...ids]])
      for (const id of ids) state.docs.delete(id)
    },
    async replaceAll(documents) {
      const all = []
      for await (const d of documents) all.push(d)
      state.writes.push(['replaceAll', all.map((d) => d.id)])
      state.docs = new Map(all.map((d) => [d.id, d]))
    },
    async search(query, params = {}) {
      const words = wordsOf(query)
      if (words.length === 0) return { items: [], total: 0, nextCursor: null }
      const items = [...state.docs.values()].filter((d) => {
        const own = wordsOf(d.fields?.name)
        return words.every((w) => own.includes(w))
      })
      return { items: items.slice(0, params.limit ?? 20), total: items.length, nextCursor: null }
    },
    async facet(field) {
      return { field, label: field, values: [] }
    },
  }
}
