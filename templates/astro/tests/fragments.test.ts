import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCategories } from '../src/lib/api'
import { headerFragment, navFragment, productFragment } from '../src/lib/fragments'

// P2-19 (spec P2-19-fragments-and-isr, invariant "Never worse than no cache"; store end state caching.fragments-cached):
// the data behind Astro's header, nav and product fragments, with `fetch` stubbed. A CDN keeps a fragment for its
// s-maxage (hours), so when the API fails (no answer, an error status, a body with no data) each fragment answers a
// 502 with `Cache-Control: no-store`, and with the API's answer it carries exactly what the API sent. The pages, which
// render per request, show no categories rather than a list the API did not send.
// Kills: the nav fragment serving the seed categories with the API down, which a CDN held for 6 h; a header cached
// without its search bar for an hour after an API blip; a 500 on a product becoming a 404.

type Failure = { kind: 'network' } | { kind: 'status'; status: number } | { kind: 'no-data' }

let answer: (url: string) => Response | Promise<Response>

beforeEach(() => {
  vi.stubGlobal('fetch', (input: string | URL) =>
    Promise.resolve().then(() => answer(String(input))),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function failing(failure: Failure): (url: string) => Response {
  return () => {
    if (failure.kind === 'network') throw new TypeError('fetch failed')
    if (failure.kind === 'no-data') return json({})
    return json({ error: { message: 'boom' } }, failure.status)
  }
}

/** Every way the API fails a read; `notFound` adds the 404, a failure for a fragment whose resource always exists. */
const failure = (notFound: boolean): fc.Arbitrary<Failure> =>
  fc.oneof(
    fc.constant<Failure>({ kind: 'network' }),
    fc.constant<Failure>({ kind: 'no-data' }),
    fc
      .integer({ min: 400, max: 599 })
      .filter((status) => notFound || status !== 404)
      .map((status): Failure => ({ kind: 'status', status })),
  )

const category = fc.record({
  id: fc.string({ minLength: 1 }),
  parentId: fc.constant(null),
  name: fc.string({ minLength: 1 }),
  slug: fc.string({ minLength: 1 }),
  description: fc.string(),
  position: fc.nat(),
  createdAt: fc.constant('2026-10-24T00:00:00Z'),
})

/** How a fragment's answer reads to a CDN: a Response's status, and whether it may store it or take it for HTML. */
function asServed(result: unknown): {
  response: boolean
  status?: number
  noStore?: boolean
  sMaxage?: boolean
  html?: boolean
} {
  if (!(result instanceof Response)) return { response: false }
  const cacheControl = result.headers.get('cache-control') ?? ''
  return {
    response: true,
    status: result.status,
    noStore: /\bno-store\b/.test(cacheControl),
    sMaxage: /s-maxage/.test(cacheControl),
    html: /text\/html/.test(result.headers.get('content-type') ?? ''),
  }
}

const notStored = (status: number) => ({
  response: true,
  status,
  noStore: true,
  sMaxage: false,
  html: false,
})

describe('P2-19: Astro fragments under an API failure', () => {
  it('caching.fragments-cached: property: when the API fails a read, the header, nav and product fragments each answer 502 with Cache-Control no-store', async () => {
    await fc.assert(
      fc.asyncProperty(failure(true), failure(false), async (whole, product) => {
        answer = failing(whole)
        expect(asServed(await headerFragment()), 'header').toEqual(notStored(502))
        expect(asServed(await navFragment()), 'nav').toEqual(notStored(502))
        answer = failing(product)
        expect(asServed(await productFragment('any-slug')), 'product').toEqual(notStored(502))
      }),
      { numRuns: 60 },
    )
  })

  it('caching.fragments-cached: property: the nav fragment carries exactly the categories the API sent, in its order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(category, { maxLength: 8 }), async (categories) => {
        answer = (url) => {
          expect(new URL(url).pathname).toBe('/api/categories')
          return json({ data: categories })
        }
        expect(await navFragment()).toEqual({ categories })
      }),
    )
  })

  it('caching.fragments-cached: the header fragment has the search bar exactly when the API says the store searches', async () => {
    for (const capabilities of [['search'], ['search', 'suggest'], ['suggest'], []]) {
      answer = () => json({ data: { search: { capabilities } } })
      expect(await headerFragment(), JSON.stringify(capabilities)).toEqual({
        canSearch: capabilities.includes('search'),
      })
    }
  })

  it('caching.fragments-cached: a product the API answers 404 for is a 404 with no-store, and one it sends is its product', async () => {
    answer = () => json({ error: { message: 'not found' } }, 404)
    expect(asServed(await productFragment('no-such-slug'))).toEqual(notStored(404))

    const product = { id: 'prod_1', slug: 'own-slug', name: 'Own', variants: [] }
    answer = (url) => {
      expect(new URL(url).pathname).toBe('/api/products/own-slug')
      return json({ data: product })
    }
    expect(await productFragment('own-slug')).toEqual({ product })
  })

  it('caching.fragments-cached: property: a page’s categories are none when the API fails, never a list the API did not send', async () => {
    await fc.assert(
      fc.asyncProperty(failure(true), async (f) => {
        answer = failing(f)
        expect(await fetchCategories()).toEqual([])
      }),
      { numRuns: 30 },
    )
  })
})
