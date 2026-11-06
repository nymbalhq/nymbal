import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PRODUCT_SORT_KEYS, type SearchDocument } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { rebuild } from '../../src/read-models/index.js'
import { createFixtureSearchAdapter } from '../../../../tests/e2e/fixtures/custom-providers/adapters.js'
import { adminSession, type AdminSession } from '../support/audit-http.js'
import { untilDelivered } from '../support/history.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  collectionOf,
  nativeSearchDocuments,
  rebuildDeps,
  recordingSearch,
} from '../support/read-models.js'

// The storefront serves only what the store sells. Over generated catalogues made through the admin API (products
// draft, active or archived, variants active or inactive, in some categories, names sharing one search term) and a
// generated tail of publish, unpublish and archive, every public read (the listing under each sort, each category's
// listing, search and the product page) serves exactly the active products, each with only its active variants and
// its figures computed over them; and a rebuild of the catalogue and search from the tables equals what the live
// projections left. A package search adapter loses a product unpublished after it was indexed.

type Json = Record<string, unknown>
type Status = 'draft' | 'active' | 'archived'
type Op = 'publish' | 'unpublish' | 'archive'

interface GenVariant {
  active: boolean
  priceMinor: number
  stock: number
}

interface GenProduct {
  status: Status
  variants: GenVariant[]
  /** Indexes into the run's categories. */
  categories: number[]
}

interface Scenario {
  categories: number
  products: GenProduct[]
  tail: Array<{ at: number; op: Op }>
}

const CATEGORY_POOL = 3

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  categories: fc.integer({ min: 1, max: CATEGORY_POOL }),
  products: fc.array(
    fc.record({
      status: fc.constantFrom<Status>('draft', 'active', 'archived'),
      variants: fc.array(
        fc.record({
          active: fc.boolean(),
          priceMinor: fc.integer({ min: 0, max: 5000 }),
          stock: fc.integer({ min: 0, max: 3 }),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      categories: fc.uniqueArray(fc.integer({ min: 0, max: CATEGORY_POOL - 1 }), { maxLength: 2 }),
    }),
    { minLength: 1, maxLength: 5 },
  ),
  tail: fc.array(
    fc.record({
      at: fc.nat({ max: 4 }),
      op: fc.constantFrom<Op>('publish', 'unpublish', 'archive'),
    }),
    { maxLength: 4 },
  ),
})

const STATUS_AFTER: Record<Op, Status> = {
  publish: 'active',
  unpublish: 'draft',
  archive: 'archived',
}

interface ModelVariant {
  id: string
  active: boolean
  priceMinor: number
  stock: number
}

interface ModelProduct {
  id: string
  slug: string
  status: Status
  /** In the order the admin read serves them. */
  variants: ModelVariant[]
  categorySlugs: string[]
}

interface Store {
  k: Kernel
  served: ServedKernel
  admin: AdminSession
  raw: RawReader
}

async function openStore(k: Kernel): Promise<Store> {
  const served = await serveKernel(k)
  return {
    k,
    served,
    admin: await adminSession(k, served.baseUrl),
    raw: openRaw(k.dialect, k.target),
  }
}

async function closeStore(s: Store | undefined): Promise<void> {
  await s?.raw.close()
  await s?.served.stop()
}

async function getJson(
  s: Store,
  path: string,
): Promise<{ status: number; body: { data?: Json; error?: { code: string } } }> {
  const res = await fetch(new URL(path, s.served.baseUrl), {
    headers: { accept: 'application/json' },
  })
  return {
    status: res.status,
    body: (await res.json()) as { data?: Json; error?: { code: string } },
  }
}

/** Makes the scenario's catalogue through the admin API, then runs its tail; returns the run's products and term. */
async function makeCatalogue(
  s: Store,
  scenario: Scenario,
): Promise<{ term: string; products: ModelProduct[]; categorySlugs: string[] }> {
  const tag = randomUUID().replace(/-/g, '').slice(0, 10)
  const term = `lst${tag}`
  const categorySlugs: string[] = []
  const categoryIds: string[] = []
  for (let c = 0; c < scenario.categories; c++) {
    const made = await s.k.services.category.create({
      slug: `listed-${tag}-${c}`,
      name: `Listed ${tag} ${c}`,
      description: '',
    })
    categorySlugs.push(made.slug)
    categoryIds.push(made.id)
  }

  const products: ModelProduct[] = []
  for (const [i, p] of scenario.products.entries()) {
    const inCategories = p.categories.filter((c) => c < scenario.categories)
    const created = await s.admin.send<{ id: string; slug: string }>(
      'POST',
      '/api/admin/products',
      {
        slug: `listed-${tag}-${i}`,
        name: `Lantern ${term} ${i}`,
        description: 'A product of the listing property.',
        status: p.status,
        type: p.variants.length > 1 ? 'variable' : 'simple',
        categoryIds: inCategories.map((c) => categoryIds[c]!),
        variants: p.variants.map((v, j) => ({
          sku: `LST-${tag}-${i}-${j}`,
          name: `Size ${j}`,
          priceMinor: v.priceMinor,
          stock: v.stock,
          options: [{ name: 'Size', value: `S${j}` }],
          status: v.active ? 'active' : 'inactive',
        })),
      },
    )
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const id = created.body.data!.id
    const read = await s.admin.send<{ variants: Array<Json> }>('GET', `/api/admin/products/${id}`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    products.push({
      id,
      slug: created.body.data!.slug,
      status: p.status,
      variants: read.body.data!.variants.map((v) => ({
        id: String(v['id']),
        active: v['status'] === 'active',
        priceMinor: Number(v['priceMinor']),
        stock: Number(v['stock']),
      })),
      categorySlugs: inCategories.map((c) => categorySlugs[c]!),
    })
  }

  for (const step of scenario.tail) {
    const product = products[step.at % products.length]!
    const res = await s.admin.send('POST', `/api/admin/products/${product.id}/${step.op}`, {})
    expect(res.status, `${step.op} ${product.slug}: ${JSON.stringify(res.body)}`).toBe(200)
    product.status = STATUS_AFTER[step.op]
  }

  await untilDelivered(s.raw)
  return { term, products, categorySlugs }
}

/** Every item a listing serves, following `nextCursor` to the last page. */
async function walk(s: Store, path: string, params: Record<string, string>): Promise<Json[]> {
  const items: Json[] = []
  let cursor: string | null = null
  for (let page = 0; page < 500; page++) {
    const query = new URLSearchParams({ ...params, ...(cursor !== null && { cursor }) })
    const res = await getJson(s, `${path}?${query.toString()}`)
    expect(res.status, `${path}?${query.toString()}: ${JSON.stringify(res.body)}`).toBe(200)
    items.push(...(res.body.data!['items'] as Json[]))
    cursor = res.body.data!['nextCursor'] as string | null
    if (cursor === null) return items
  }
  throw new Error(`${path}: the walk did not end`)
}

const sorted = (xs: string[]): string[] => [...xs].sort()
const slugsOf = (items: Json[]): string[] => items.map((i) => String(i['slug']))

/** A category facet as [slug, count] pairs, sorted. */
function facetPairs(facet: {
  values: Array<{ value: string; count?: number }>
}): Array<[string, number]> {
  return facet.values
    .map((v) => [v.value, Number(v.count)] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/** The served products' count in each category, as [slug, count] pairs, sorted; categories with none left out. */
function expectedFacet(served: ModelProduct[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const p of served) for (const c of p.categorySlugs) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

/** What the storefront serves of a product: its active variants, and its figures over them. */
function expectedDoc(p: ModelProduct): Json {
  const active = p.variants.filter((v) => v.active)
  const prices = active.map((v) => v.priceMinor)
  return {
    variantIds: sorted(active.map((v) => v.id)),
    variantCount: active.length,
    inStock: active.some((v) => v.stock > 0),
    priceRange:
      prices.length === 0 ? null : { minMinor: Math.min(...prices), maxMinor: Math.max(...prices) },
    priceMinor: prices[0] ?? null,
  }
}

function servedDoc(doc: Json): Json {
  return {
    variantIds: sorted((doc['variants'] as Json[]).map((v) => String(v['id']))),
    variantCount: doc['variantCount'],
    inStock: doc['inStock'],
    priceRange: doc['priceRange'],
    priceMinor: doc['priceMinor'],
  }
}

/** Every public read of the store against the model: `all` is every product the store holds, `run` this run's. */
async function expectServesOnlyListed(
  s: Store,
  all: ModelProduct[],
  run: { term: string; products: ModelProduct[]; categorySlugs: string[] },
  label: string,
): Promise<void> {
  const listed = all.filter((p) => p.status === 'active')
  const listedSlugs = sorted(listed.map((p) => p.slug))

  for (const sort of PRODUCT_SORT_KEYS) {
    const items = await walk(s, '/api/products', { sort, limit: '3' })
    expect(slugsOf(items).length, `${label}: /api/products?sort=${sort} repeats nothing`).toBe(
      new Set(slugsOf(items)).size,
    )
    expect(sorted(slugsOf(items)), `${label}: /api/products?sort=${sort}`).toEqual(listedSlugs)
  }

  const first = await getJson(s, '/api/products?limit=1')
  const listFacets = first.body.data!['facets'] as Array<{
    field: string
    values: Array<{ value: string; count?: number }>
  }>
  expect(facetPairs(listFacets[0]!), `${label}: the listing's category facet`).toEqual(
    expectedFacet(listed),
  )

  for (const category of run.categorySlugs) {
    const items = await walk(s, '/api/products', { category, limit: '2' })
    expect(sorted(slugsOf(items)), `${label}: /api/products?category=${category}`).toEqual(
      sorted(listed.filter((p) => p.categorySlugs.includes(category)).map((p) => p.slug)),
    )
  }

  const runListed = run.products.filter((p) => p.status === 'active')
  const searched: Json[] = []
  const totals: number[] = []
  let searchFacets: Array<{ values: Array<{ value: string; count?: number }> }> = []
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({
      q: run.term,
      limit: '2',
      ...(cursor !== null && { cursor }),
    })
    const res = await getJson(s, `/api/products/search?${query.toString()}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const data = res.body.data!
    if (page === 0) searchFacets = data['facets'] as typeof searchFacets
    searched.push(...(data['items'] as Json[]))
    totals.push(Number(data['total']))
    cursor = data['nextCursor'] as string | null
    if (cursor === null) break
  }
  expect(sorted(slugsOf(searched)), `${label}: search ${run.term}`).toEqual(
    sorted(runListed.map((p) => p.slug)),
  )
  expect(totals, `${label}: search total on each page`).toEqual(totals.map(() => runListed.length))
  // With nothing served the route sends no facet at all.
  expect(
    searchFacets.map((f) => facetPairs(f)),
    `${label}: the search's category facet`,
  ).toEqual(runListed.length === 0 ? [] : [expectedFacet(runListed)])
}

const PROPERTY_RUNS = 10

describe('the storefront serves only the listed catalogue', () => {
  it('AC-1: property: over generated catalogues and publish, unpublish and archive tails, the listing under every sort, each category, search (items, total and facet) and the product page serve exactly the active products, each with only its active variants and its stock, price range and price over them', async () => {
    let s: Store | undefined
    try {
      s = await openStore(await createKernel({ dialect: 'sqlite' }))
      const store = s
      const all: ModelProduct[] = []
      await fc.assert(
        fc.asyncProperty(arbScenario, async (scenario) => {
          const run = await makeCatalogue(store, scenario)
          all.push(...run.products)
          const label = JSON.stringify(scenario)
          await expectServesOnlyListed(store, all, run, label)

          // The product page: 200 with the listed figures for an active product, 404 not_found for the rest.
          const pages = await Promise.all(
            run.products.map((p) => getJson(store, `/api/products/${p.slug}`)),
          )
          expect(
            pages.map((res, i) => [
              run.products[i]!.slug,
              res.status,
              res.body.error?.code ?? null,
            ]),
            `${label}: GET /api/products/:slug`,
          ).toEqual(
            run.products.map((p) =>
              p.status === 'active' ? [p.slug, 200, null] : [p.slug, 404, 'not_found'],
            ),
          )
          expect(
            pages.flatMap((res, i) =>
              run.products[i]!.status === 'active' ? [servedDoc(res.body.data!)] : [],
            ),
            `${label}: each served product's variants and figures`,
          ).toEqual(run.products.filter((p) => p.status === 'active').map(expectedDoc))
        }),
        {
          numRuns: PROPERTY_RUNS,
          examples: [
            [
              {
                categories: 2,
                products: [
                  {
                    status: 'active',
                    variants: [
                      { active: false, priceMinor: 100, stock: 3 },
                      { active: true, priceMinor: 900, stock: 0 },
                      { active: true, priceMinor: 400, stock: 0 },
                    ],
                    categories: [0, 1],
                  },
                  {
                    status: 'draft',
                    variants: [{ active: true, priceMinor: 500, stock: 2 }],
                    categories: [0],
                  },
                  {
                    status: 'active',
                    variants: [{ active: true, priceMinor: 700, stock: 1 }],
                    categories: [1],
                  },
                ],
                tail: [{ at: 2, op: 'unpublish' }],
              },
            ],
          ],
        },
      )
    } finally {
      await closeStore(s)
    }
  }, 300_000)

  it('AC-2: property: after the same generated catalogues and tails, a rebuild of the catalogue and search into a fresh document store and index equals the live products, products-by-category and index documents, key by key', async () => {
    let s: Store | undefined
    try {
      s = await openStore(await createKernel({ dialect: 'sqlite' }))
      const store = s
      await fc.assert(
        fc.asyncProperty(arbScenario, async (scenario) => {
          await makeCatalogue(store, scenario)
          const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
          const search = recordingSearch()
          try {
            await rebuild(['catalogue', 'search'], rebuildDeps(store.k, { documentStore, search }))
            for (const collection of ['products', 'products-by-category']) {
              expect(
                await collectionOf(documentStore, collection),
                `${JSON.stringify(scenario)}: ${collection}`,
              ).toEqual(await collectionOf(store.k.documentStore, collection))
            }
            const asJson = (docs: SearchDocument[]) =>
              JSON.parse(JSON.stringify(docs)) as SearchDocument[]
            expect(asJson(search.documents()), `${JSON.stringify(scenario)}: the index`).toEqual(
              asJson(await nativeSearchDocuments(store.k)),
            )
          } finally {
            await documentStore.close()
          }
        }),
        { numRuns: PROPERTY_RUNS },
      )
    } finally {
      await closeStore(s)
    }
  }, 300_000)
})

describe('a package search adapter loses an unpublished product', () => {
  it('AC-3: on the custom-providers fixture adapter, a product unpublished after it was indexed leaves the adapter’s index and the search route: total drops by one and the other product stays', async () => {
    const adapter = createFixtureSearchAdapter()
    let s: Store | undefined
    try {
      s = await openStore(
        await createKernel({
          dialect: 'sqlite',
          configure: (config) => ({
            ...config,
            commerce: { ...config.commerce, search: { provider: 'custom' } },
          }),
          appOptions: { adapters: { search: adapter } },
        }),
      )
      const tag = randomUUID().replace(/-/g, '').slice(0, 10)
      const term = `pkg${tag}`
      const made: Array<{ id: string; slug: string }> = []
      for (const i of [0, 1]) {
        const res = await s.admin.send<{ id: string; slug: string }>(
          'POST',
          '/api/admin/products',
          {
            slug: `pkg-${tag}-${i}`,
            name: `Package ${term} ${i}`,
            description: 'Indexed by a package adapter.',
            status: 'active',
            variants: [
              { sku: `PKG-${tag}-${i}`, name: 'Default', priceMinor: 1200, stock: 4, options: [] },
            ],
          },
        )
        expect(res.status, JSON.stringify(res.body)).toBe(201)
        made.push({ id: res.body.data!.id, slug: res.body.data!.slug })
      }
      const [gone, kept] = made as [{ id: string; slug: string }, { id: string; slug: string }]
      await untilDelivered(s.raw)
      const before = await getJson(s, `/api/products/search?q=${term}`)
      expect(before.status, JSON.stringify(before.body)).toBe(200)
      const indexedBefore = (await adapter.search(term)).total

      const unpublished = await s.admin.send('POST', `/api/admin/products/${gone.id}/unpublish`, {})
      expect(unpublished.status, JSON.stringify(unpublished.body)).toBe(200)
      await untilDelivered(s.raw)

      expect((await adapter.search(term)).total, 'the adapter’s index').toBe(indexedBefore - 1)
      const after = await getJson(s, `/api/products/search?q=${term}`)
      expect(after.status, JSON.stringify(after.body)).toBe(200)
      expect(Number(after.body.data!['total']), 'the route’s total').toBe(
        Number(before.body.data!['total']) - 1,
      )
      expect(slugsOf(after.body.data!['items'] as Json[])).toEqual([kept.slug])
    } finally {
      await closeStore(s)
    }
  }, 60_000)
})
