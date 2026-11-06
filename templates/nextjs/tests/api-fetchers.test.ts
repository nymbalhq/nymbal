import fc from 'fast-check'
import { notFound, redirect } from 'next/navigation'
import { DynamicServerError } from 'next/dist/client/components/hooks-server-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from '@/lib/api'

// AC-7: the Next template's fetchers with `fetch` stubbed. (a) What `unstable_rethrow` passes on (Next's dynamic-usage
// error, `notFound()`'s and `redirect()`'s) reaches the caller from every fetcher. (b) A network error or a 5xx rejects
// every catalog fetcher (products, product, categories, capabilities, reviews), so a failed render is an error Next
// does not cache and a failed regeneration keeps the last good page, and rejects `loadOrder`, so a failed order read is
// never the not-found page, while the cart and search fetchers still resolve to null. (c) `fetchProduct` and
// `loadOrder` are null on a 404 only, and `fetchCategories` is the API's list. (d) The
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
  loadOrder: (api: Api) => api.loadOrder('N-1', 'key-1'),
  fetchSearch: (api: Api) => api.fetchSearch('wool', null),
} as const
const EVERY = { ...CATALOG, ...SHOPPER }
type Name = keyof typeof EVERY
/** The fetchers a network error or a 5xx rejects, and those it resolves to null. */
const REJECTS_ON_FAILURE: readonly Name[] = [...(Object.keys(CATALOG) as Name[]), 'loadOrder']
const NULL_ON_FAILURE: readonly Name[] = ['fetchCart', 'fetchSearch']

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

  it('AC-7 (b, c): on a network TypeError or a 5xx the catalog fetchers and loadOrder reject and the cart and search fetchers resolve null; fetchProduct and loadOrder are null on a 404; over generated lists, fetchCategories resolves to exactly the API’s list', async () => {
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
      for (const name of REJECTS_ON_FAILURE) {
        const { outcome } = await only(name, api)
        if (outcome.ok) wrong.push(`${name} resolved ${JSON.stringify(outcome.value)} on ${kind}`)
      }
      for (const name of NULL_ON_FAILURE) {
        const { outcome } = await only(name, api)
        if (!outcome.ok || outcome.value !== null)
          wrong.push(`${name} did not resolve null on ${kind}`)
      }
    }
    expect(wrong).toEqual([])

    answer = () => json(null, 404)
    expect(await api.fetchProduct('no-such-slug')).toBeNull()
    expect(await api.loadOrder('N-404', 'key-1')).toBeNull()
    answer = okFor
    expect(await api.fetchProduct('test-product')).toEqual(PRODUCT)
    expect(await api.loadOrder('N-1', 'key-1')).toEqual({ orderNumber: 'N-1' })

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
    // Two cold imports of the PDP's module graph: up to 1.5 s alone; a loaded gate has pushed it past the 5 s default.
  }, 30_000)

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

// AC-6: the order page's server-side fetchers, the expired page's and the not-found page's server action reads with
// when the page's script does not run. The email a shopper types reaches the API only in a header or a JSON body,
// never in a URL; the link request carries the CSRF pair `GET /api/csrf` answered, as a cookie and a header; a busy
// rate limit is an answer the page shows ('limited'), never a thrown error that renders a 500.

interface Sent {
  url: string
  method: string
  headers: Headers
  body: string | null
  cache: RequestCache | undefined
}

/** Replaces the file's `fetch` stub with one that records each request whole, whether given an init or a Request. */
function recordRequests(reply: (call: Sent) => Response): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const call: Sent = {
      url: request?.url ?? String(input),
      method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers ?? request?.headers),
      body:
        typeof init?.body === 'string'
          ? init.body
          : request !== null
            ? await request.clone().text()
            : null,
      cache: init?.cache ?? request?.cache,
    }
    sent.push(call)
    return reply(call)
  })
  return sent
}

const refusal = (status: number): Response =>
  new Response(JSON.stringify({ error: { code: 'refused', message: 'refused' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Emails with the characters a URL would carry differently: `+`, `%`, `&`, `?`, `#`, a space. */
const anEmail = fc
  .tuple(
    fc.array(fc.constantFrom('a', 'z', '7', '.', '+', '%', '&', '?', '#', ' ', '='), {
      minLength: 1,
      maxLength: 12,
    }),
    fc.constantFrom('example.test', 'shop.example', 'e2e.test'),
  )
  .map(([local, domain]) => `s${local.join('')}x@${domain}`)

/** The URLs among `sent` that carry `email` as typed, percent-encoded, form-encoded or once decoded. */
function urlsCarrying(sent: Sent[], email: string): string[] {
  const forms = [
    email,
    encodeURIComponent(email),
    encodeURI(email),
    new URLSearchParams({ e: email }).toString().slice(2),
  ].map((f) => f.toLowerCase())
  return sent
    .map((c) => c.url)
    .filter((url) => {
      let decoded = url
      try {
        decoded = decodeURIComponent(url)
      } catch {
        // A URL that does not decode is checked as it is.
      }
      return [url, decoded].some((u) => forms.some((f) => u.toLowerCase().includes(f)))
    })
}

describe('AC-6: the Next order page’s server fetchers', () => {
  it('AC-6: over generated emails, openExpiredOrder sends GET /api/orders/:n with cache no-store, the key and the email in their headers and no URL carrying the email; 200 is the order, 404 not-found, 429 limited, any other failure or a network error rejects', async () => {
    const api = await load()
    type ReadAnswer = number | 'network'
    const readAnswer: fc.Arbitrary<ReadAnswer> = fc.oneof(
      fc.constantFrom<ReadAnswer>(200, 404, 429, 'network'),
      fc.integer({ min: 400, max: 599 }).filter((s) => s !== 404 && s !== 429),
    )
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,6}$/),
        fc.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        anEmail,
        readAnswer,
        async (orderNumber, key, email, status) => {
          const order = { orderNumber, totalMinor: 1999, currency: 'GBP', lineItems: [] }
          const sent = recordRequests(() => {
            if (status === 'network') throw new TypeError('fetch failed')
            return status === 200 ? json(order) : refusal(status)
          })
          const outcome = await settle(api.openExpiredOrder(orderNumber, key, email))

          const reads = sent.filter(
            (c) => new URL(c.url).pathname === `/api/orders/${encodeURIComponent(orderNumber)}`,
          )
          expect(reads.map((c) => [c.method, c.cache])).toEqual([['GET', 'no-store']])
          expect(reads[0]!.headers.get('x-nymbal-order-key')).toBe(key)
          expect(reads[0]!.headers.get('x-nymbal-order-email')?.toLowerCase()).toBe(
            email.toLowerCase(),
          )
          expect(urlsCarrying(sent, email)).toEqual([])

          const expected =
            status === 200
              ? { ok: true, value: order }
              : status === 404
                ? { ok: true, value: 'not-found' }
                : status === 429
                  ? { ok: true, value: 'limited' }
                  : { ok: false }
          expect(outcome.ok ? { ok: true, value: outcome.value } : { ok: false }).toEqual(expected)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-6: over generated emails and tokens, requestOrderLink gets GET /api/csrf, then POSTs /api/orders/link with that answer’s nymbal.csrf cookie equal to its x-csrf-token header, the number and email in a JSON body and no URL carrying the email; 202 is sent, 429 limited, any other answer, a failed csrf read or a network error rejects', async () => {
    const api = await load()
    type LinkAnswer = number | 'network' | 'csrf-fails'
    const linkAnswer: fc.Arbitrary<LinkAnswer> = fc.oneof(
      fc.constantFrom<LinkAnswer>(202, 429, 'network', 'csrf-fails'),
      fc.integer({ min: 400, max: 599 }).filter((s) => s !== 429),
    )
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,6}$/),
        anEmail,
        fc.stringMatching(/^[0-9a-f]{64}$/),
        linkAnswer,
        async (orderNumber, email, token, status) => {
          const sent = recordRequests((call) => {
            const path = new URL(call.url).pathname
            if (path === '/api/csrf') {
              if (status === 'csrf-fails') return refusal(500)
              return new Response(JSON.stringify({ data: { token } }), {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  'set-cookie': `nymbal.csrf=${token}; Path=/; SameSite=Lax`,
                },
              })
            }
            if (path === '/api/orders/link') {
              if (status === 'network') throw new TypeError('fetch failed')
              return status === 202 ? json({ sent: 'if-matched' }, 202) : refusal(status as number)
            }
            throw new Error(`unexpected fetch ${call.method} ${call.url}`)
          })
          const outcome = await settle(api.requestOrderLink(orderNumber, email))
          expect(urlsCarrying(sent, email)).toEqual([])

          const post = sent.find(
            (c) => c.method === 'POST' && new URL(c.url).pathname === '/api/orders/link',
          )
          const cookies = Object.fromEntries(
            (post?.headers.get('cookie') ?? '')
              .split(';')
              .map((pair) => pair.trim().split('='))
              .filter((pair) => pair.length === 2),
          )
          const seen = {
            requests: sent.map((c) => `${c.method} ${new URL(c.url).pathname}`),
            cookie: cookies['nymbal.csrf'] ?? null,
            header: post?.headers.get('x-csrf-token') ?? null,
            json: /^application\/json/.test(post?.headers.get('content-type') ?? ''),
            body: post?.body ? (JSON.parse(post.body) as unknown) : null,
            outcome: outcome.ok ? { ok: true, value: outcome.value } : { ok: false },
          }
          // The pair is the csrf answer's own: its cookie and its token, so the API's double-submit check passes.
          expect(seen).toEqual(
            status === 'csrf-fails'
              ? {
                  requests: ['GET /api/csrf'],
                  cookie: null,
                  header: null,
                  json: false,
                  body: null,
                  outcome: { ok: false },
                }
              : {
                  requests: ['GET /api/csrf', 'POST /api/orders/link'],
                  cookie: token,
                  header: token,
                  json: true,
                  body: { orderNumber, email },
                  outcome:
                    status === 202
                      ? { ok: true, value: 'sent' }
                      : status === 429
                        ? { ok: true, value: 'limited' }
                        : { ok: false },
                },
          )
        },
      ),
      { numRuns: 60 },
    )
  })
})

// AC-10: the API attests a no-JS shopper's address to this server on the page request (`x-nymbal-shopper`). The
// server's own calls for that shopper echo it, so the API counts them against the shopper and not against this server.
const SHOPPER_HEADER = 'x-nymbal-shopper'

/** Header values as the API mints them, and any other visible ASCII a client could send. */
const aShopperValue = fc.oneof(
  fc
    .tuple(fc.oneof(fc.ipV4(), fc.ipV6()), fc.integer({ min: 0, max: 4_102_444_800_000 }))
    .chain(([ip, at]) =>
      fc.stringMatching(/^[A-Za-z0-9_-]{43}$/).map((mac) => `${ip}~${at}~${mac}`),
    ),
  fc.stringMatching(/^[!-~]{1,120}$/),
)
/** Other request headers a page request carries. */
const otherHeaders = fc.dictionary(
  fc.constantFrom(
    'accept',
    'cookie',
    'user-agent',
    'x-forwarded-for',
    'x-nymbal-order-key',
    'referer',
  ),
  fc.stringMatching(/^[!-~]{1,40}$/),
)

type ShopperFetcher = 'openExpiredOrder' | 'requestOrderLink' | 'confirmAlert' | 'unsubscribeAlert'

/** One call of the fetcher with `forwarded` (or no argument), answered as a success; the requests it made. */
async function callShopperFetcher(
  api: Api,
  name: ShopperFetcher,
  forwarded: Record<string, string> | undefined,
  token: string,
) {
  const sent = recordRequests((call) => {
    const path = new URL(call.url).pathname
    if (path === '/api/csrf') {
      return new Response(JSON.stringify({ data: { token } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': `nymbal.csrf=${token}; Path=/`,
        },
      })
    }
    if (path === '/api/orders/link') return json({ sent: 'if-matched' }, 202)
    if (path.startsWith('/api/orders/')) {
      return json({ orderNumber: 'N-1', totalMinor: 1, currency: 'GBP', lineItems: [] })
    }
    if (path === '/api/alerts/confirm') {
      return json({ kind: 'back-in-stock', product: { name: 'P', slug: 'p' } })
    }
    if (path === '/api/alerts/unsubscribe') return json({ status: 'unsubscribed' })
    throw new Error(`unexpected fetch ${call.method} ${call.url}`)
  })
  const args = forwarded === undefined ? [] : [forwarded]
  const run = () => {
    switch (name) {
      case 'openExpiredOrder':
        return api.openExpiredOrder('N-1', 'k'.repeat(43), 'shopper@shop.example', ...args)
      case 'requestOrderLink':
        return api.requestOrderLink('N-1', 'shopper@shop.example', ...args)
      case 'confirmAlert':
        return api.confirmAlert(token, ...args)
      case 'unsubscribeAlert':
        return api.unsubscribeAlert(token, ...args)
    }
  }
  return { sent, outcome: await settle(run()) }
}

describe('AC-10: the Next server fetchers echo the shopper attestation', () => {
  it('AC-10: over generated headers, shopperHeaders returns { x-nymbal-shopper: v } exactly when the inbound headers carry v, and {} otherwise', async () => {
    const api = await load()
    fc.assert(
      fc.property(otherHeaders, fc.option(aShopperValue, { nil: undefined }), (others, value) => {
        const inbound = new Headers(others)
        if (value !== undefined) inbound.set(SHOPPER_HEADER, value)

        expect(api.shopperHeaders(inbound)).toEqual(
          value === undefined ? {} : { [SHOPPER_HEADER]: value },
        )
      }),
      { numRuns: 200 },
    )
  })

  it('AC-10: openExpiredOrder, requestOrderLink, confirmAlert and unsubscribeAlert send x-nymbal-shopper: v on every API request when given it, and no such header when not; the link request keeps its CSRF cookie and header', async () => {
    const api = await load()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ShopperFetcher>(
          'openExpiredOrder',
          'requestOrderLink',
          'confirmAlert',
          'unsubscribeAlert',
        ),
        fc.option(aShopperValue, { nil: undefined }),
        fc.boolean(),
        fc.stringMatching(/^[0-9a-f]{64}$/),
        async (name, value, passEmpty, token) => {
          const forwarded: Record<string, string> | undefined =
            value !== undefined ? { [SHOPPER_HEADER]: value } : passEmpty ? {} : undefined
          const { sent, outcome } = await callShopperFetcher(api, name, forwarded, token)
          const link = sent.find((c) => new URL(c.url).pathname === '/api/orders/link')

          expect(outcome.ok, String(outcome.ok ? '' : outcome.error)).toBe(true)
          expect(sent.length).toBe(name === 'requestOrderLink' ? 2 : 1)
          expect(sent.map((c) => c.headers.get(SHOPPER_HEADER))).toEqual(
            sent.map(() => value ?? null),
          )
          expect(
            link === undefined
              ? null
              : [link.headers.get('x-csrf-token'), link.headers.get('cookie')],
          ).toEqual(name === 'requestOrderLink' ? [token, `nymbal.csrf=${token}`] : null)
        },
      ),
      { numRuns: 120 },
    )
  })
})
