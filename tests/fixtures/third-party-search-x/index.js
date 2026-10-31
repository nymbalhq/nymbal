// A search adapter as a third party ships one: plain JavaScript with no dependency and no relative import outside its
// own directory, so it installs from its path or a tarball anywhere. It declares one required secret and one optional
// setting, each read from an environment variable, which is what `nymbal add <package>` lists in .env.example.

/** The search terms of a text: maximal runs of ASCII letters and digits, lowercased. */
function termsOf(text) {
  return typeof text === 'string' ? (text.toLowerCase().match(/[a-z0-9]+/g) ?? []) : []
}

export const slot = 'search'
export const provider = 'acme-x'

export const settings = [
  { path: 'apiKey', label: 'Acme Search API key', secret: true, env: 'ACME_SEARCH_KEY' },
  {
    path: 'region',
    label: 'Acme Search region',
    secret: false,
    env: 'ACME_SEARCH_REGION',
    optional: true,
  },
]

// The kernel stands a not-configured adapter in for this one while ACME_SEARCH_KEY is set nowhere, so the adapter
// itself is healthy whenever it is built.
export function createAdapter() {
  const docs = new Map()
  return {
    kind: 'search',
    providerName: 'acme-x',
    capabilities: () => ['index', 'search'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    healthCheck: async () => ({ status: 'healthy' }),

    async index(documents) {
      for (const doc of documents) docs.set(doc.id, { ...doc, fields: { ...doc.fields } })
      return { indexed: documents.length }
    },

    async remove(ids) {
      for (const id of ids) docs.delete(id)
    },

    async search(query, params = {}) {
      const q = termsOf(query)
      if (q.length === 0) return { items: [], total: 0, nextCursor: null }
      const hits = [...docs.values()].filter((doc) => {
        const terms = termsOf(doc.fields.name)
        return q.every((t) => terms.some((d) => d.startsWith(t)))
      })
      const limit = params.limit ?? 20
      return { items: hits.slice(0, limit), total: hits.length, nextCursor: null }
    },

    async facet(field) {
      return { field, label: field, values: [] }
    },
  }
}
