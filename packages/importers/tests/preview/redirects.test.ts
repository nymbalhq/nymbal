import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseCsv } from '../../../../tests/support/csv.js'
import { buildRedirects, formatRedirectsCsv } from '../../src/preview/redirects.js'

// The redirect map a merchant hands their host: every WooCommerce category and every listed product's URL to its
// Nymbal URL, one row per URL. The expected map is worked out here from WooCommerce's records alone: a category's
// URL from its ancestry, a product's from its permalink.

type Rec = Record<string, unknown>

interface Row {
  from: string
  to: string
  status: number
}
interface Unredirected {
  kind: 'product' | 'category'
  wcId: number
  reason: string
}

const STORE_B_CATEGORIES = fileURLToPath(
  new URL('../integration/fixtures/recorded/store-b-jpy/categories.json', import.meta.url),
)

type PermalinkKind = 'pretty' | 'custom' | 'shared' | 'plain'

const permalinkOf = (kind: PermalinkKind, id: number, slug: string): string =>
  kind === 'pretty'
    ? `http://localhost:8888/product/${slug}/`
    : kind === 'custom'
      ? `https://shop.example/shop/${slug}/`
      : kind === 'shared'
        ? 'https://shop.example/shop/shared-name/'
        : `http://localhost:8888/?post_type=product&p=${id}`

/** A category forest: parents are other categories, none, or an id the source does not hold. */
const arbCategories = fc
  .uniqueArray(fc.integer({ min: 1, max: 400 }), { maxLength: 9 })
  .chain((ids) =>
    fc
      .tuple(
        ...ids.map(() =>
          fc.record({ parentPick: fc.integer({ min: 0, max: 20 }), missing: fc.boolean() }),
        ),
      )
      .map((picks) => {
        const sorted = [...ids].sort((a, b) => a - b)
        return ids.map((id, i): Rec => {
          const earlier = sorted.filter((other) => other < id)
          const { parentPick, missing } = picks[i]!
          const parent =
            earlier.length === 0 || parentPick % 3 === 0
              ? missing
                ? 9000 + id
                : 0
              : earlier[parentPick % earlier.length]!
          return { id, name: `Category ${id}`, slug: `cat-${id}`, parent }
        })
      }),
  )

const arbProducts = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 400 }),
    kind: fc.constantFrom<PermalinkKind>('pretty', 'custom', 'shared', 'plain'),
    listed: fc.boolean(),
  }),
  { selector: (p) => p.id, maxLength: 10 },
)

interface Input {
  sourceCategories: Rec[]
  categories: Array<{ source: Rec; nymbalSlug: string }>
  products: Array<{ source: Rec; nymbalSlug: string; listed: boolean }>
}

const arbInput: fc.Arbitrary<Input> = fc
  .tuple(arbCategories, arbProducts)
  .map(([sourceCategories, products]) => ({
    sourceCategories,
    categories: sourceCategories.map((source) => ({
      source,
      nymbalSlug: `n-${source['slug'] as string}`,
    })),
    products: products.map(({ id, kind, listed }) => {
      const slug = `p-${id}`
      return {
        source: { id, name: `Product ${id}`, slug, permalink: permalinkOf(kind, id, slug) },
        nymbalSlug: `np-${id}`,
        listed,
      }
    }),
  }))

/** What WooCommerce served each record at and where Nymbal serves it, read from the records alone. */
function expectedMap(input: Input) {
  const byId = new Map(input.sourceCategories.map((c) => [c['id'] as number, c]))
  const categoryPath = (c: Rec): string => {
    const chain = [c['slug'] as string]
    let parent = c['parent'] as number
    while (parent !== 0 && byId.has(parent)) {
      const up = byId.get(parent)!
      chain.unshift(up['slug'] as string)
      parent = up['parent'] as number
    }
    return `/product-category/${chain.join('/')}/`
  }
  const rows: Row[] = []
  const taken = new Map<string, number>()
  const later = new Map<string, number[]>()
  const unredirected: Unredirected[] = []
  const byWcId = <T extends { source: Rec }>(xs: T[]) =>
    [...xs].sort((a, b) => (a.source['id'] as number) - (b.source['id'] as number))
  for (const c of byWcId(input.categories)) {
    rows.push({ from: categoryPath(c.source), to: `/category/${c.nymbalSlug}`, status: 301 })
  }
  for (const p of byWcId(input.products)) {
    const wcId = p.source['id'] as number
    const permalink = p.source['permalink'] as string
    if (!p.listed) {
      unredirected.push({ kind: 'product', wcId, reason: 'imported as a draft' })
      continue
    }
    const url = new URL(permalink)
    if (url.search !== '') {
      unredirected.push({ kind: 'product', wcId, reason: `plain permalink: ${permalink}` })
      continue
    }
    if (taken.has(url.pathname)) {
      later.set(url.pathname, [...(later.get(url.pathname) ?? []), wcId])
      continue
    }
    taken.set(url.pathname, wcId)
    rows.push({ from: url.pathname, to: `/product/${p.nymbalSlug}`, status: 301 })
  }
  return { rows, unredirected, taken, later }
}

const byKindAndId = (xs: Unredirected[]) =>
  [...xs].sort((a, b) => a.kind.localeCompare(b.kind) || a.wcId - b.wcId)

describe('buildRedirects', () => {
  it('AC-2: for generated category forests and products, one row per category and listed product, from by ancestry or permalink, to the Nymbal URL, status 301, no from twice, later ids in duplicates and every unlisted or plain-permalink product unredirected', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const expected = expectedMap(input)

        const result = buildRedirects(input)

        expect(result.rows).toEqual(expected.rows)
        expect(new Set(result.rows.map((r) => r.from)).size).toBe(result.rows.length)
        expect(byKindAndId(result.unredirected)).toEqual(byKindAndId(expected.unredirected))
        const duplicated = new Map<string, Set<number>>()
        for (const d of result.duplicates) {
          const ids = duplicated.get(d.from) ?? new Set<number>()
          for (const id of d.wcIds) if (id !== expected.taken.get(d.from)) ids.add(id)
          duplicated.set(d.from, ids)
        }
        expect(
          Object.fromEntries(
            [...duplicated].map(([from, ids]) => [from, [...ids].sort((a, b) => a - b)]),
          ),
        ).toEqual(
          Object.fromEntries(
            [...expected.later].map(([from, ids]) => [from, [...ids].sort((a, b) => a - b)]),
          ),
        )
      }),
      { numRuns: 300 },
    )
  })

  it("AC-2: store B's matcha, under tea under food, redirects from /product-category/food/tea/matcha/ to /category/matcha", () => {
    const sourceCategories = JSON.parse(readFileSync(STORE_B_CATEGORIES, 'utf8')) as Rec[]

    const { rows } = buildRedirects({
      sourceCategories,
      categories: sourceCategories.map((source) => ({
        source,
        nymbalSlug: source['slug'] as string,
      })),
      products: [],
    })

    expect(rows.find((r) => r.to === '/category/matcha')).toEqual({
      from: '/product-category/food/tea/matcha/',
      to: '/category/matcha',
      status: 301,
    })
  })
})

describe('formatRedirectsCsv', () => {
  const cell = fc.string({
    unit: fc.constantFrom('a', 'z', '/', '-', ',', '"', '\r', '\n', ' ', 'é', '%'),
    maxLength: 24,
  })

  it('AC-2: parsed as RFC 4180, the CSV gives back the header and every row, whatever commas, quotes and line breaks its fields hold, each line ending in a newline', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ from: cell, to: cell, status: fc.constant(301 as const) }), {
          maxLength: 8,
        }),
        (rows) => {
          const csv = formatRedirectsCsv(rows)

          expect(parseCsv(csv)).toEqual([
            ['from', 'to', 'status'],
            ...rows.map((r) => [r.from, r.to, String(r.status)]),
          ])
          expect(csv.endsWith('\n')).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-2: a from holding a comma and a quote survives the round trip', () => {
    const rows = [{ from: '/product/a,"b"/', to: '/product/a-b', status: 301 as const }]

    expect(parseCsv(formatRedirectsCsv(rows))).toEqual([
      ['from', 'to', 'status'],
      ['/product/a,"b"/', '/product/a-b', '301'],
    ])
  })
})
