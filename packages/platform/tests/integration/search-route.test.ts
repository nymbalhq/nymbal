import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SearchAdapter } from '@nymbalhq/types'
import { encodeSearchCursor } from '../../src/adapters/search/native-adapter.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { createFixtureSearchAdapter } from '../../../../tests/e2e/fixtures/custom-providers/adapters.js'

// P2-07 AC-5, and AC-4's route half, over HTTP against a kernel built from `src/` (decision 6):
// GET /api/products/search?q&limit&cursor&category returns {items, nextCursor, total, facets}. Walking `cursor` at
// `limit=n` reproduces the adapter's own walk; `category=<slug>` narrows items and total to the category; for a
// query with a match `facets` is [the category facet] iff search reports `facet`, in the listing's shape (field
// `category`, slug values, name labels), counting the full walk's products per category; a miss gives `facets: []`.
// A malformed cursor is a 400; a cursor at or past total is an empty last page.
// Kills: a route that drops `total`, hard-codes `facets: []`, ignores `category`, emits category ids where the
// listing emits slugs, reads a malformed cursor as page 1, or errors on a stale one.

interface Category {
  id: string
  slug: string
  name: string
}

interface RouteProduct {
  slug: string
  categories?: Array<{ id: string; slug: string; name: string }>
}

interface SearchBody {
  items: RouteProduct[]
  nextCursor: string | null
  total: number
  facets: Array<{
    field: string
    label: string
    values: Array<{ value: string; label?: string; count?: number }>
  }>
}

async function get(
  served: ServedKernel,
  params: Record<string, string>,
): Promise<{ status: number; text: string; body: { data?: SearchBody } }> {
  const res = await fetch(
    `${served.baseUrl}/api/products/search?${new URLSearchParams(params).toString()}`,
    { headers: { accept: 'application/json' } },
  )
  const text = await res.text()
  let body: { data?: SearchBody } = {}
  try {
    body = JSON.parse(text) as { data?: SearchBody }
  } catch {
    // A non-JSON answer leaves the body empty; the status says what happened.
  }
  return { status: res.status, text, body }
}

interface Walk {
  slugs: string[]
  totals: number[]
  pages: SearchBody[]
}

/** The route's walk: page 1, then every nextCursor until null. */
async function routeWalk(served: ServedKernel, params: Record<string, string>): Promise<Walk> {
  const pages: SearchBody[] = []
  let cursor: string | null = null
  for (let n = 0; n < 200; n++) {
    const res = await get(served, { ...params, ...(cursor !== null && { cursor }) })
    expect(
      res.status,
      `GET /api/products/search ${JSON.stringify(params)}: ${res.text.slice(0, 300)}`,
    ).toBe(200)
    const page = res.body.data!
    pages.push(page)
    cursor = page.nextCursor
    if (cursor === null) break
  }
  expect(cursor, 'the route walk did not end').toBeNull()
  return {
    slugs: pages.flatMap((p) => p.items.map((i) => i.slug)),
    totals: pages.map((p) => p.total),
    pages,
  }
}

/** The adapter's walk for the same query, as slugs. */
async function adapterWalk(
  search: SearchAdapter,
  query: string,
  limit: number,
  filters?: Record<string, unknown>,
): Promise<{ slugs: string[]; total: number }> {
  const slugs: string[] = []
  let cursor: string | null = null
  let total = Number.NaN
  for (let n = 0; n < 200; n++) {
    const page = await search.search(query, {
      limit,
      ...(cursor !== null && { cursor }),
      ...(filters !== undefined && { filters }),
    })
    total = page.total
    slugs.push(...page.items.map((d) => String(d.fields['slug'])))
    cursor = page.nextCursor
    if (cursor === null) break
  }
  return { slugs, total }
}

/** A catalogue of the test's own: products sharing a token, across two of three categories, some in both, some in
 *  none, and some that carry the token only in their description. */
async function seedCatalogue(served: ServedKernel, token: string) {
  const { services } = served.kernel
  const cats: Category[] = []
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const c = await services.category.create({
      slug: `p2-07-${name.toLowerCase()}-${token}`,
      name: `${name} ${token}`,
      description: '',
    })
    cats.push({ id: c.id, slug: c.slug, name: c.name })
  }
  const [alpha, beta] = cats as [Category, Category, Category]
  const created: Array<{ slug: string; categorySlugs: string[] }> = []
  for (let i = 0; i < 34; i++) {
    const inCats = i >= 30 ? [] : i % 3 === 0 ? [alpha] : i % 3 === 1 ? [beta] : [alpha, beta]
    const nameHit = i < 28
    const slug = `p2-07-route-${token}-${i}`
    await services.product.create({
      slug,
      name: nameHit ? `Route ${token} item${i}` : `Elsewhere item${i}`,
      description: nameHit ? 'A product of the route test.' : `Mentions ${token} only here.`,
      status: 'active',
      categoryIds: inCats.map((c) => c.id),
      variants: [
        { sku: `RT-${token}-${i}`, name: 'Default', priceMinor: 1000 + i, stock: 3, options: [] },
      ],
    })
    created.push({ slug, categorySlugs: inCats.map((c) => c.slug) })
  }
  return { cats, created }
}

const token = () => `rt${randomUUID().replace(/-/g, '').slice(0, 12)}`

describe('P2-07 AC-5: GET /api/products/search on the native store (search reports facet)', () => {
  let served: ServedKernel
  let tok: string
  let seeded: Awaited<ReturnType<typeof seedCatalogue>>

  beforeAll(async () => {
    served = await serveKernel(await createKernel({ dialect: 'sqlite' }))
    tok = token()
    seeded = await seedCatalogue(served, tok)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  it('AC-5: walking cursor at limit=n reproduces the adapter’s walk for the query, and every page’s total is the adapter’s, the number of matching products', async () => {
    const search = served.kernel.app.adapters.search
    expect(search.capabilities()).toContain('facet')
    for (const limit of [1, 4, 7, 100]) {
      const route = await routeWalk(served, { q: tok, limit: String(limit) })
      const adapter = await adapterWalk(search, tok, limit)
      expect(route.totals, `limit ${limit}: total on each page`).toEqual(
        route.pages.map(() => adapter.total),
      )
      expect(adapter.total, 'every product carrying the token matches').toBe(seeded.created.length)
      expect(route.slugs, `limit ${limit}: the route's walk`).toEqual(adapter.slugs)
    }
  })

  it('AC-5: category=<slug> narrows items and total to that category, as the adapter’s walk under filters.categoryIds; an unknown slug gives no items and total 0', async () => {
    const search = served.kernel.app.adapters.search
    for (const cat of seeded.cats) {
      const expected = seeded.created
        .filter((p) => p.categorySlugs.includes(cat.slug))
        .map((p) => p.slug)
      const route = await routeWalk(served, { q: tok, limit: '5', category: cat.slug })
      expect([...route.slugs].sort(), `category ${cat.slug}`).toEqual([...expected].sort())
      expect(route.totals, `category ${cat.slug}: total on each page`).toEqual(
        route.pages.map(() => expected.length),
      )
      const adapter = await adapterWalk(search, tok, 5, { categoryIds: cat.id })
      expect(route.slugs, `category ${cat.slug}: the route's walk`).toEqual(adapter.slugs)
    }
    const unknown = await get(served, { q: tok, category: `no-such-category-${tok}` })
    expect(unknown.status, unknown.text.slice(0, 300)).toBe(200)
    expect(unknown.body.data!.items).toEqual([])
    expect(unknown.body.data!.total).toBe(0)
  })

  it('AC-5: for a query with a match, facets is the category facet with slug values and name labels, counting the full walk’s products per category; a miss gives facets []', async () => {
    const full = await routeWalk(served, { q: tok, limit: '100' })
    const expected = new Map<string, { label: string; count: number }>()
    for (const product of full.pages.flatMap((p) => p.items)) {
      for (const c of product.categories ?? []) {
        expected.set(c.slug, { label: c.name, count: (expected.get(c.slug)?.count ?? 0) + 1 })
      }
    }
    expect(expected.size, 'the seeded products sit in two categories').toBe(2)

    const first = await get(served, { q: tok, limit: '3' })
    const facets = first.body.data!.facets
    expect(facets.map((f) => f.field)).toEqual(['category'])
    const shown = Object.fromEntries(
      facets[0]!.values.map((v) => [v.value, { label: v.label, count: v.count }]),
    )
    expect(shown).toEqual(Object.fromEntries(expected))

    const miss = await get(served, { q: `zq${tok}` })
    expect(miss.status, miss.text.slice(0, 300)).toBe(200)
    expect(miss.body.data!.total).toBe(0)
    expect(miss.body.data!.facets).toEqual([])
  })

  it('AC-4: a malformed cursor (undecodable, negative, non-integer) is a 400 at the route; a cursor at or past total is an empty page with nextCursor null and the total', async () => {
    for (const cursor of ['not a cursor', '!!']) {
      const res = await get(served, { q: tok, cursor })
      expect(res.status, `cursor ${JSON.stringify(cursor)}: ${res.text.slice(0, 200)}`).toBe(400)
    }
    for (const offset of [-1, 1.5]) {
      const res = await get(served, { q: tok, cursor: encodeSearchCursor(offset) })
      expect(res.status, `cursor at ${offset}: ${res.text.slice(0, 200)}`).toBe(400)
    }
    const total = seeded.created.length
    for (const offset of [total, total + 5]) {
      const res = await get(served, { q: tok, limit: '10', cursor: encodeSearchCursor(offset) })
      expect(res.status, `cursor at ${offset}: ${res.text.slice(0, 200)}`).toBe(200)
      expect(res.body.data!.items.length).toBe(0)
      expect(res.body.data!.nextCursor).toBeNull()
      expect(res.body.data!.total).toBe(total)
    }
  })
})

describe('P2-07 AC-5: GET /api/products/search on a store whose search does not report facet', () => {
  let served: ServedKernel
  let tok: string
  let seeded: Awaited<ReturnType<typeof seedCatalogue>>

  beforeAll(async () => {
    served = await serveKernel(
      await createKernel({
        dialect: 'sqlite',
        configure: (config) => ({
          ...config,
          commerce: { ...config.commerce, search: { provider: 'custom' } },
        }),
        appOptions: { adapters: { search: createFixtureSearchAdapter() } },
      }),
    )
    tok = token()
    seeded = await seedCatalogue(served, tok)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  it('AC-5: for a query with a match, facets is [], and the walk and total are still the adapter’s', async () => {
    const search = served.kernel.app.adapters.search
    expect(search.capabilities()).not.toContain('facet')
    const route = await routeWalk(served, { q: tok, limit: '6' })
    const adapter = await adapterWalk(search, tok, 6)
    expect(adapter.total).toBe(seeded.created.length)
    expect(route.totals).toEqual(route.pages.map(() => adapter.total))
    expect(route.slugs).toEqual(adapter.slugs)
    for (const page of route.pages) expect(page.facets).toEqual([])
  })
})
