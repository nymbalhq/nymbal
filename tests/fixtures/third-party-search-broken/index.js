// The broken twin of tests/fixtures/third-party-search: the same in-memory search, whose `contractOptions` turn on
// `ignoreCursor`, so every search reads page 1 whatever cursor it is given and the published search suite refuses
// to certify it. Its package.json carries install, prepare and prepack scripts that leave marker files behind: the
// registry run installs and packs with scripts off, so none of them may ever exist.

/** The search terms of a text: maximal runs of ASCII letters and digits, lowercased. */
function termsOf(text) {
  return typeof text === 'string' ? (text.toLowerCase().match(/[a-z0-9]+/g) ?? []) : []
}

function docTerms(doc) {
  const variants = Array.isArray(doc.fields.variants) ? doc.fields.variants : []
  return [
    ...termsOf(doc.fields.name),
    ...variants.flatMap((v) => [...termsOf(v.sku), ...termsOf(v.name)]),
    ...termsOf(doc.fields.description),
  ]
}

function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeCursor(cursor) {
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  if (!/^\d+$/.test(text) || encodeCursor(Number(text)) !== cursor) {
    throw new Error(`malformed search cursor ${JSON.stringify(cursor)}`)
  }
  return Number(text)
}

export const slot = 'search'
export const provider = 'acme-broken'

export function createAdapter(options = {}) {
  const ignoreCursor = options !== null && options.ignoreCursor === true
  const docs = new Map()
  let dead = false
  return {
    kind: 'search',
    providerName: 'acme-search-broken',
    capabilities: () => ['index', 'search'],
    producesEvents: [],
    consumesEvents: [],
    async initialize(config) {
      dead = config !== null && typeof config === 'object' && config.dead === true
    },
    healthCheck: async () =>
      dead ? { status: 'down', detail: 'index unreachable' } : { status: 'healthy' },

    async index(documents) {
      for (const doc of documents) docs.set(doc.id, { ...doc, fields: { ...doc.fields } })
      return { indexed: documents.length }
    },

    async remove(ids) {
      for (const id of ids) docs.delete(id)
    },

    async search(query, params = {}) {
      if (dead) throw new Error('search index unreachable')
      const offset = params.cursor === undefined || ignoreCursor ? 0 : decodeCursor(params.cursor)
      const q = termsOf(query)
      if (q.length === 0) return { items: [], total: 0, nextCursor: null }
      const category = params.filters?.categoryIds
      const hits = [...docs.values()].filter((doc) => {
        if (category !== undefined) {
          const ids = doc.fields.categoryIds
          if (!Array.isArray(ids) || !ids.includes(category)) return false
        }
        const terms = docTerms(doc)
        return q.every((t) => terms.some((d) => d.startsWith(t)))
      })
      const limit = params.limit ?? 20
      const end = offset + limit
      return {
        items: hits.slice(offset, end),
        total: hits.length,
        nextCursor: end < hits.length ? encodeCursor(end) : null,
      }
    },

    async facet(field) {
      return { field, label: field, values: [] }
    },
  }
}

/** Certified with the cursor ignored: the pagination cases fail. */
export const contractOptions = { options: { ignoreCursor: true }, unreachable: { dead: true } }
