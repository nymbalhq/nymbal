import fc from 'fast-check'
import { notFound, redirect } from 'next/navigation'
import { DynamicServerError } from 'next/dist/client/components/hooks-server-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from '@/lib/api'

// AC-7: the Next template's fetchers with `fetch` stubbed. (a) What `unstable_rethrow` passes on (Next's dynamic-usage
// error, `notFound()`'s and `redirect()`'s) reaches the caller from every fetcher. (b) A network error or a 5xx rejects
// every catalog fetcher (products, product, categories, capabilities, reviews), so a failed render is an error Next
// does not cache and a failed regeneration keeps the last good page, while the shopper fetchers (cart, order, search)
// still resolve to null. (c) `fetchProduct` is null on a 404 only, and `fetchCategories` is the API's list. (d) The
// catalog fetchers pass `next.revalidate` (capabilities 3600, categories 21600, product 300, products 300, reviews 60,
// the product 60 when the PDP reads it, or NYMBAL_CATALOG_REVALIDATE_S when set) and never `cache: 'no-store'`; the
// shopper fetchers keep `no-store`.

type Api = typeof ApiModule

interface Call {
  url: string
  init: (RequestInit & { next?: { revalidate?: number | false } }) | undefined
}

const calls: Call[] = []
let answer: (url: string) => Response | Promise<Response> = () => {
  throw new Error('no answer set')
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: { message: 'boom' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const CATEGORY = {
  id: 'cat_test',
  parentId: null,
  name: 'Store Own',
  slug: 'store-own',
  description: 'A category only this store has',
  position: 0,
  createdAt: '2026-10-24T00:00:00Z',
}
const PRODUCT = { id: 'prod_test', slug: 'test-product', name: 'Test Product', variants: [] }
const LIST = { items: [PRODUCT], nextCursor: null }

/** A 200 body each fetcher accepts, by the path it asks for. */
function okFor(url: string): Response {
  const path = new URL(url).pathname
  if (path === '/api/capabilities') return json({ search: { capabilities: ['search'] } })
  if (path === '/api/categories') return json([CATEGORY])
  if (path === '/api/products' || path === '/api/products/search') return json(LIST)
  if (path.endsWith('/reviews')) return json({ items: [], nextCursor: null })
  if (path.startsWith('/api/products/')) return json(PRODUCT)
  if (path === '/api/cart') return json({ items: [], subtotalMinor: 0, currency: 'GBP' })
  if (path.startsWith('/api/orders/')) return json({ orderNumber: 'N-1' })
  throw new Error(`unexpected fetch ${url}`)
}

/** Loads lib/api.ts afresh with NYMBAL_CATALOG_REVALIDATE_S set to `seconds`, or unset. */
async function load(seconds?: string): Promise<Api> {
  if (seconds === undefined) delete process.env['NYMBAL_CATALOG_REVALIDATE_S']
  else process.env['NYMBAL_CATALOG_REVALIDATE_S'] = seconds
  vi.resetModules()
  return import('@/lib/api')
}

let cookieSeq = 0
const CATALOG = {
  fetchProducts: (api: Api) => api.fetchProducts({ limit: 8 }),
  fetchProduct: (api: Api) => api.fetchProduct('test-product'),
  fetchCategories: (api: Api) => api.fetchCategories(),
  fetchCapabilities: (api: Api) => api.fetchCapabilities(),
  fetchReviews: (api: Api) => api.fetchReviews('prod_test'),
} as const
const SHOPPER = {
  // A distinct cookie per call: React's `cache` must not answer from an earlier call.
  fetchCart: (api: Api) => api.fetchCart(`nymbal.cart=fragments-${(cookieSeq += 1)}`),
  fetchOrder: (api: Api) => api.fetchOrder('N-1'),
  fetchSearch: (api: Api) => api.fetchSearch('wool', null),
} as const
const EVERY = { ...CATALOG, ...SHOPPER }
type Name = keyof typeof EVERY

/** Each catalog fetcher's seconds. */
const REVALIDATE: Record<keyof typeof CATALOG, number> = {
  fetchCapabilities: 3600,
  fetchCategories: 21600,
  fetchProduct: 300,
  fetchProducts: 300,
  fetchReviews: 60,
}

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

/** How a call settled: the value it resolved to, or the error it rejected with. */
async function settle(
  run: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await run }
  } catch (error) {
    return { ok: false, error }
  }
}

/** The one fetch call a fetcher made, and how it settled. */
async function only(name: Name, api: Api) {
  const before = calls.length
  const outcome = await settle(EVERY[name](api))
  const made = calls.slice(before)
  expect(made.length, `${name} makes one fetch`).toBe(1)
  return { call: made[0]!, outcome }
}

beforeEach(() => {
  calls.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: Call['init']) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return answer(url)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env['NYMBAL_CATALOG_REVALIDATE_S']
})

describe('AC-7: the Next fetchers’ failure modes and cache options', () => {
  it('AC-7 (a): when fetch throws what unstable_rethrow rethrows (Next’s dynamic-usage error, notFound()’s, redirect()’s), every fetcher in lib/api.ts rejects with that same error', async () => {
    const api = await load()
    const signals: Record<string, unknown> = {
      'dynamic usage': new DynamicServerError('no-store fetch during prerender'),
      'notFound()': thrown(() => notFound()),
      'redirect()': thrown(() => redirect('/account/login')),
    }
    const swallowed: string[] = []
    for (const [kind, signal] of Object.entries(signals)) {
      answer = () => {
        throw signal
      }
      for (const name of Object.keys(EVERY) as Name[]) {
        const { outcome } = await only(name, api)
        if (outcome.ok || outcome.error !== signal) swallowed.push(`${name} swallowed ${kind}`)
      }
    }
    expect(swallowed).toEqual([])
  })

  it('AC-7 (b, c): on a network TypeError or a 500 the catalog fetchers reject and the shopper fetchers resolve null; fetchProduct is null on a 404; over generated lists, fetchCategories resolves to exactly the API’s list', async () => {
    const api = await load()
    const wrong: string[] = []
    const failures: Record<string, () => Response> = {
      'a network TypeError': () => {
        throw new TypeError('fetch failed')
      },
      'a 500': () => json(null, 500),
      'a 503': () => json(null, 503),
    }
    for (const [kind, failure] of Object.entries(failures)) {
      answer = failure
      for (const name of Object.keys(CATALOG) as Array<keyof typeof CATALOG>) {
        const { outcome } = await only(name, api)
        if (outcome.ok) wrong.push(`${name} resolved ${JSON.stringify(outcome.value)} on ${kind}`)
      }
      for (const name of Object.keys(SHOPPER) as Array<keyof typeof SHOPPER>) {
        const { outcome } = await only(name, api)
        if (!outcome.ok || outcome.value !== null)
          wrong.push(`${name} did not resolve null on ${kind}`)
      }
    }
    expect(wrong).toEqual([])

    answer = () => json(null, 404)
    expect(await api.fetchProduct('no-such-slug')).toBeNull()
    answer = okFor
    expect(await api.fetchProduct('test-product')).toEqual(PRODUCT)

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            id: fc.stringMatching(/^cat_[a-z0-9]{1,8}$/),
            parentId: fc.constant(null),
            name: fc.string({ minLength: 1, maxLength: 12 }),
            slug: fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
            description: fc.string({ maxLength: 20 }),
            position: fc.nat(50),
            createdAt: fc.constant('2026-10-24T00:00:00Z'),
          }),
          { maxLength: 6, selector: (c) => c.id },
        ),
        async (sent) => {
          answer = () => json(sent)
          expect(await api.fetchCategories()).toEqual(sent)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('AC-7 (d): unset NYMBAL_CATALOG_REVALIDATE_S, each catalog fetcher passes next.revalidate of its own seconds and no cache: no-store; cart, order and search keep cache: no-store', async () => {
    const api = await load()
    answer = okFor
    const seen: Record<string, { revalidate: unknown; cache: unknown }> = {}
    for (const name of Object.keys(EVERY) as Name[]) {
      const { call, outcome } = await only(name, api)
      expect(outcome.ok, `${name} on a 200`).toBe(true)
      seen[name] = { revalidate: call.init?.next?.revalidate, cache: call.init?.cache }
    }
    expect(
      Object.fromEntries(Object.keys(REVALIDATE).map((name) => [name, seen[name]!.revalidate])),
    ).toEqual(REVALIDATE)
    for (const name of Object.keys(REVALIDATE)) {
      expect(seen[name]!.cache, `${name} cache`).not.toBe('no-store')
    }
    for (const name of Object.keys(SHOPPER)) {
      expect(seen[name]!.cache, `${name} cache`).toBe('no-store')
    }
  })

  it('AC-7 (d): fetchProduct called by the PDP (its page and generateMetadata) passes 60, the PDP’s own seconds, and no cache: no-store, while fetchProduct called with no seconds keeps 300', async () => {
    await load()
    answer = okFor
    const pdp = await import('@/app/(catalog)/product/[slug]/page')
    const productCalls = () =>
      calls.filter((c) => new URL(c.url).pathname === '/api/products/test-product')
    const params = Promise.resolve({ slug: 'test-product' })

    await pdp.generateMetadata({ params })
    await pdp.default({ params })
    expect(
      productCalls().map((c) => ({ revalidate: c.init?.next?.revalidate, cache: c.init?.cache })),
      'the PDP’s product reads',
    ).toEqual([
      { revalidate: 60, cache: undefined },
      { revalidate: 60, cache: undefined },
    ])

    const api = await import('@/lib/api')
    calls.length = 0
    await api.fetchProduct('test-product')
    expect(productCalls().map((c) => c.init?.next?.revalidate)).toEqual([300])

    // NYMBAL_CATALOG_REVALIDATE_S replaces the PDP's seconds too.
    await load('2')
    const overridden = await import('@/app/(catalog)/product/[slug]/page')
    calls.length = 0
    await overridden.generateMetadata({ params })
    expect(productCalls().map((c) => c.init?.next?.revalidate)).toEqual([2])
  })

  it('AC-7 (d): over generated NYMBAL_CATALOG_REVALIDATE_S values, every catalog fetcher’s next.revalidate is that number, and the shopper fetchers still pass cache: no-store', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 86_400 }), async (seconds) => {
        const api = await load(String(seconds))
        answer = okFor
        for (const name of Object.keys(CATALOG) as Array<keyof typeof CATALOG>) {
          const { call } = await only(name, api)
          expect(call.init?.next?.revalidate, name).toBe(seconds)
          expect(call.init?.cache, name).not.toBe('no-store')
        }
        for (const name of Object.keys(SHOPPER) as Array<keyof typeof SHOPPER>) {
          const { call } = await only(name, api)
          expect(call.init?.cache, name).toBe('no-store')
        }
      }),
      { numRuns: 15 },
    )
  })
})
