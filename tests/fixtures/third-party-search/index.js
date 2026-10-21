// P2-13 AC-6 and AC-7 (spec P2-13-contract-tests-public): a search adapter as a third party ships one, plain
// JavaScript with no dependency, so it installs from a tarball anywhere and loads in Node without a build. It is the
// in-memory search of the P2-05 swap fixture (tests/e2e/fixtures/custom-providers/adapters.ts): P2-07 decision 3's
// matching over name, SKU, variant name and description, a category filter, an offset cursor it validates, an exact
// total, no `facet` and no ranking promised.
//
// `createAdapter(options)` takes the `config` record of the store's slot that names this package. With
// `ignoreCursor: true` its search reads page 1 whatever cursor it is given: the variant the published search suite
// must refuse to certify. Like adapter-smtp it reads its connection settings again in `initialize(config)`: there
// `dead: true` points it at an index it cannot reach, so its health is `down` and its search rejects.

/** Decision 3's terms of a text: maximal runs of ASCII letters and digits, lowercased. */
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

export function createAdapter(options = {}) {
  const ignoreCursor = options !== null && options.ignoreCursor === true
  const docs = new Map()
  let dead = false
  return {
    kind: 'search',
    providerName: 'acme-search',
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

/**
 * What `nymbal test:contracts` falls back to when no slot of the store names this package, and the options of an
 * adapter whose index cannot be reached, for the downtime cases.
 */
export const contractOptions = { options: {}, unreachable: { dead: true } }
