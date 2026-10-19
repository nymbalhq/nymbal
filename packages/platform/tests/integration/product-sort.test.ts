import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProductSortKey } from '@nymbalhq/types'
import type { DenormalisedProduct } from '../../src/handlers/projections/product-projection.js'
import { runSeed } from '../../src/seed/run.js'
import { seedProducts } from '../../src/seed/data.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'

// P1-11 AC-1 to AC-4 over HTTP on a served kernel (SQLite): `GET /api/products?sort=<key>` orders by the key with ties
// broken by slug and unpriced products last, paging under a key yields the whole sorted list, an unknown key or a cursor
// from another key is refused, and no key means `newest`. The expected order is computed here from the read model
// (the document store), never from the route under test. Kills: `sort` stripped by the schema or ignored by the handler,
// ordering by `priceMinor` (first variant) instead of the "from" price, case- or accent-sensitive name compare, a
// cursor that restarts or repeats under a non-key order, a stale cursor silently accepted, a slug-order default.

const KEYS: ProductSortKey[] = ['newest', 'price-asc', 'price-desc', 'name-asc', 'name-desc']

interface Listing {
  items: DenormalisedProduct[]
  nextCursor: string | null
}

interface Answer {
  status: number
  body: { data?: Listing; error?: { code?: string } }
}

async function getProducts(
  served: ServedKernel,
  query: Record<string, string | number | undefined>,
): Promise<Answer> {
  const url = new URL('/api/products', served.baseUrl)
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(name, String(value))
  }
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as Answer['body'] }
}

/** An answer in one line: the error, or the slugs it listed. */
function described(answer: Answer): string {
  if (answer.body.error) return JSON.stringify(answer.body.error)
  return `items ${JSON.stringify(answer.body.data?.items.map((p) => p.slug))}`
}

async function listed(
  served: ServedKernel,
  query: Record<string, string | number | undefined>,
): Promise<Listing> {
  const answer = await getProducts(served, query)
  expect(answer.status, described(answer)).toBe(200)
  return answer.body.data!
}

/** Every page under `query`, following `nextCursor` to the end (bounded, so a cursor that restarts cannot loop). */
async function walk(
  served: ServedKernel,
  query: Record<string, string | number | undefined>,
  maxPages: number,
): Promise<string[]> {
  const slugs: string[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await listed(served, { ...query, cursor })
    if (typeof query.limit === 'number') expect(page.items.length).toBeLessThanOrEqual(query.limit)
    slugs.push(...page.items.map((p) => p.slug))
    cursor = page.nextCursor ?? undefined
    pages += 1
  } while (cursor !== undefined && pages <= maxPages)
  expect(cursor, `the cursor walk did not end within ${maxPages} pages`).toBeUndefined()
  return slugs
}

const fromPrice = (p: DenormalisedProduct): number | null => p.priceRange?.minMinor ?? null
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** The spec's order for a key (Decision 1): the key, then slug ascending; a product with no price last in both price orders. */
function compareBy(key: ProductSortKey) {
  return (a: DenormalisedProduct, b: DenormalisedProduct): number => {
    let c = 0
    switch (key) {
      case 'newest':
        c = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        break
      case 'price-asc':
      case 'price-desc': {
        const pa = fromPrice(a)
        const pb = fromPrice(b)
        if (pa === null || pb === null) c = pa === pb ? 0 : pa === null ? 1 : -1
        else c = key === 'price-asc' ? pa - pb : pb - pa
        break
      }
      case 'name-asc':
        c = byName(a.name, b.name)
        break
      case 'name-desc':
        c = byName(b.name, a.name)
        break
    }
    if (c !== 0) return c
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  }
}

/** The read model's documents for these slugs, sorted by the spec's order for `key`. */
async function expectedOrder(k: Kernel, slugs: string[], key: ProductSortKey): Promise<string[]> {
  const docs = await Promise.all(
    slugs.map(async (slug) => {
      const doc = await k.documentStore.get<DenormalisedProduct>('products', slug)
      expect(doc, `read model has no product ${slug}`).not.toBeNull()
      return doc!
    }),
  )
  return docs.sort(compareBy(key)).map((d) => d.slug)
}

const sortedCopy = (xs: string[]) => [...xs].sort()

// Generated catalogues: names that tie under sensitivity `base` (case, accents), "from" prices that differ from the
// first variant's price, products with no variant (no price), and slug prefixes that make slug order differ from
// creation order.
const NAMES = ['apple', 'Apple', 'Äpple', 'banana', 'Banana', 'cherry', 'éclair', 'Eclair', 'zebra']
const productArb = fc.record({
  prefix: fc.constantFrom('a', 'k', 'm', 'z'),
  name: fc.constantFrom(...NAMES),
  prices: fc.array(
    fc.integer({ min: 1, max: 6 }).map((n) => n * 100),
    { maxLength: 3 },
  ),
})
const catalogueArb = fc.array(productArb, { minLength: 1, maxLength: 8 })
type GeneratedProduct = { prefix: string; name: string; prices: number[] }

let counter = 0

/** A fresh category holding exactly these products, served by the read side before this returns. */
async function seedCatalogue(
  k: Kernel,
  served: ServedKernel,
  catalogue: GeneratedProduct[],
): Promise<{ category: string; slugs: string[] }> {
  const run = ++counter
  const category = `p1-11-cat-${run}`
  const cat = await k.services.category.create({
    slug: category,
    name: `Sort ${run}`,
    description: '',
  })
  await vi.waitFor(
    async () => {
      const res = await fetch(new URL('/api/categories', served.baseUrl))
      const body = (await res.json()) as { data: Array<{ slug: string }> }
      expect(body.data.map((c) => c.slug)).toContain(category)
    },
    { timeout: 5_000, interval: 10 },
  )
  const slugs: string[] = []
  for (const [i, p] of catalogue.entries()) {
    const slug = `${p.prefix}-${run}-${i}`
    await k.services.product.create({
      slug,
      name: p.name,
      description: '',
      status: 'active',
      categoryIds: [cat.id],
      variants: p.prices.map((priceMinor, v) => ({
        sku: `P111-${run}-${i}-${v}`,
        name: `V${v}`,
        priceMinor,
        stock: 1,
        lowStockThreshold: 0,
        options: [],
      })),
    })
    slugs.push(slug)
  }
  await vi.waitFor(
    async () => {
      const page = await listed(served, { category, limit: 100 })
      expect(page.items.length).toBe(slugs.length)
    },
    { timeout: 5_000, interval: 10 },
  )
  return { category, slugs }
}

describe('GET /api/products sort, on the seeded catalogue', () => {
  let k: Kernel
  let served: ServedKernel
  const seeded = seedProducts.map((p) => p.slug)

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    await runSeed({
      config: k.config,
      commandStore: k.store,
      documentStore: k.documentStore,
      eventBus: k.eventBus,
      logger: k.logger,
      version: '0.0.0',
    })
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  it('AC-1: for every key, the seeded catalogue comes back as a permutation in that key’s order', async () => {
    for (const key of KEYS) {
      const page = await listed(served, { sort: key, limit: 100 })
      const slugs = page.items.map((p) => p.slug)
      expect(sortedCopy(slugs), key).toEqual(sortedCopy(seeded))
      expect(slugs, key).toEqual(await expectedOrder(k, seeded, key))
    }
  })

  it('AC-2: paging with limit=3 under every key yields exactly the full sorted list, with no duplicate and no gap', async () => {
    for (const key of KEYS) {
      const slugs = await walk(served, { sort: key, limit: 3 }, seeded.length)
      expect(new Set(slugs).size, `${key}: duplicates`).toBe(slugs.length)
      expect(slugs, key).toEqual(await expectedOrder(k, seeded, key))
    }
  })

  it('AC-3: an unknown sort answers 400 validation.failed', async () => {
    const unknown = await getProducts(served, { sort: 'price-sideways' })
    expect(unknown.status, described(unknown)).toBe(400)
    expect(unknown.body.error?.code).toBe('validation.failed')
  })

  it('AC-3: a cursor from price-asc sent with name-asc, or with no sort, answers 400 validation.failed', async () => {
    const first = await listed(served, { sort: 'price-asc', limit: 3 })
    expect(first.nextCursor).not.toBeNull()
    const cursor = first.nextCursor!

    const crossed = await getProducts(served, { sort: 'name-asc', limit: 3, cursor })
    expect(crossed.status, described(crossed)).toBe(400)
    expect(crossed.body.error?.code).toBe('validation.failed')

    // No sort is `newest` (Decision 2), so the price-asc cursor is from another key there too.
    const defaulted = await getProducts(served, { limit: 3, cursor })
    expect(defaulted.status, described(defaulted)).toBe(400)
    expect(defaulted.body.error?.code).toBe('validation.failed')

    // The same cursor under its own key still pages.
    const same = await listed(served, { sort: 'price-asc', limit: 3, cursor })
    expect(same.items.length).toBeGreaterThan(0)
  })
})

describe('GET /api/products sort, on generated catalogues', () => {
  let k: Kernel
  let served: ServedKernel

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  it('AC-1: for every key, a generated catalogue comes back as a permutation in that key’s order', async () => {
    await fc.assert(
      fc.asyncProperty(catalogueArb, async (catalogue) => {
        const { category, slugs } = await seedCatalogue(k, served, catalogue)
        for (const key of KEYS) {
          const page = await listed(served, { category, sort: key, limit: 100 })
          const got = page.items.map((p) => p.slug)
          expect(sortedCopy(got), key).toEqual(sortedCopy(slugs))
          expect(got, key).toEqual(await expectedOrder(k, slugs, key))
        }
      }),
      { numRuns: 15 },
    )
  })

  it('AC-2: paging under any key and limit yields exactly the full sorted list, with no duplicate and no gap', async () => {
    await fc.assert(
      fc.asyncProperty(
        catalogueArb,
        fc.constantFrom(...KEYS),
        fc.integer({ min: 1, max: 5 }),
        async (catalogue, key, limit) => {
          const { category, slugs } = await seedCatalogue(k, served, catalogue)
          const got = await walk(served, { category, sort: key, limit }, slugs.length + 1)
          expect(new Set(got).size, 'duplicates').toBe(got.length)
          expect(got).toEqual(await expectedOrder(k, slugs, key))
        },
      ),
      { numRuns: 15 },
    )
  })

  it('AC-4: no sort returns the newest order, the same as sort=newest, in a category and across the store', async () => {
    const run = ++counter
    const category = `p1-11-newest-${run}`
    const cat = await k.services.category.create({
      slug: category,
      name: 'Newest',
      description: '',
    })
    await vi.waitFor(
      async () => {
        const res = await fetch(new URL('/api/categories', served.baseUrl))
        const body = (await res.json()) as { data: Array<{ slug: string }> }
        expect(body.data.map((c) => c.slug)).toContain(category)
      },
      { timeout: 5_000, interval: 10 },
    )
    // Created in an order that is neither slug order nor its reverse, each strictly later than the one before.
    const slugs: string[] = []
    let last = 0
    for (const prefix of ['b', 'd', 'a', 'c']) {
      while (Date.now() <= last) await new Promise((resolve) => setImmediate(resolve))
      const slug = `${prefix}-newest-${run}`
      const created = await k.services.product.create({
        slug,
        name: slug,
        description: '',
        status: 'active',
        categoryIds: [cat.id],
        variants: [
          {
            sku: `N-${slug}`,
            name: 'Default',
            priceMinor: 500,
            stock: 1,
            lowStockThreshold: 0,
            options: [],
          },
        ],
      })
      last = new Date(created.createdAt).getTime()
      slugs.push(slug)
    }
    await vi.waitFor(
      async () => {
        const page = await listed(served, { category, limit: 100 })
        expect(page.items.length).toBe(slugs.length)
      },
      { timeout: 5_000, interval: 10 },
    )

    const inCategory = (await listed(served, { category, limit: 100 })).items.map((p) => p.slug)
    const inCategoryNewest = (
      await listed(served, { category, sort: 'newest', limit: 100 })
    ).items.map((p) => p.slug)
    expect(inCategory).toEqual(await expectedOrder(k, slugs, 'newest'))
    expect(inCategory).toEqual(inCategoryNewest)

    const all = await walk(served, { limit: 100 }, 50)
    const allNewest = await walk(served, { sort: 'newest', limit: 100 }, 50)
    expect(all).toEqual(await expectedOrder(k, all, 'newest'))
    expect(all).toEqual(allNewest)
  })
})
