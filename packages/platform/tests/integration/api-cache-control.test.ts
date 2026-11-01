import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { adminClient } from '../support/money.js'
import { CSRF_COOKIE, CSRF_HEADER, login, primedShopper } from '../support/security.js'
import { unaudited } from '../support/write-audit.js'

// Neither a shared cache nor the browser's disk cache keeps an API answer that does not choose its own caching: every
// answer under /api/ without a Cache-Control of its own says `no-store` (route answers, the guard's refusals,
// Fastify's own 404 and body-parse 400). A route's own choice is kept, the event stream keeps its own, and nothing
// outside /api/ is touched.

interface Seen {
  what: string
  status: number
  cacheControl: string | null
}

async function seen(what: string, res: Promise<Response>): Promise<Seen> {
  const answer = await res
  await answer.body?.cancel()
  return { what, status: answer.status, cacheControl: answer.headers.get('cache-control') }
}

const listed = (answers: Seen[]): string =>
  answers.map((a) => `${a.what} ${a.status} ${JSON.stringify(a.cacheControl)}`).join('; ')

describe('Cache-Control on API answers', () => {
  let k: Kernel
  let served: ServedKernel
  let seeded: Seeded
  let customerToken: string

  beforeAll(async () => {
    // adminRoot null: /admin/ answers its build hint, so the route outside /api/ is served.
    k = await createKernel({ dialect: 'sqlite', appOptions: { adminRoot: null } })
    served = await serveKernel(k)
    seeded = await seedVariant(k, 50)
    const email = `cache-${randomUUID()}@cache.test`
    const password = 'correct-horse-battery'
    const now = new Date()
    await unaudited(() =>
      k.store.transaction((tx) =>
        k.repos.customer.insert(tx, {
          id: randomUUID(),
          email,
          passwordHash: bcrypt.hashSync(password, 4),
          roles: ['customer'],
          requiresPasswordReset: false,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    )
    const shop = await primedShopper(served.baseUrl)
    const answer = await login(served.baseUrl, shop.jar, { email, password })
    if (answer.status !== 200) throw new Error(`login: ${JSON.stringify(answer.body)}`)
    customerToken = answer.body.data!.accessToken
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  const url = (path: string) => new URL(path, served.baseUrl)

  it('AC-7: every /api/ answer that sets no Cache-Control of its own says no-store: guest and signed-in cart, products, csrf, a 403 csrf.invalid, a 401, Fastify’s 404 and its body-parse 400', async () => {
    const shop = await primedShopper(served.baseUrl)
    const token = shop.jar.get(CSRF_COOKIE)!
    const pair = { cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: token }
    const answers = await Promise.all([
      seen('guest GET /api/cart', fetch(url('/api/cart'))),
      seen(
        'signed-in GET /api/cart',
        fetch(url('/api/cart'), { headers: { authorization: `Bearer ${customerToken}` } }),
      ),
      seen('GET /api/products', fetch(url('/api/products'))),
      seen('GET /api/csrf', fetch(url('/api/csrf'))),
      seen(
        'cookieless POST /api/cart/items',
        fetch(url('/api/cart/items'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ variantId: seeded.variantId, qty: 1 }),
        }),
      ),
      seen('GET /api/customers/me with no bearer', fetch(url('/api/customers/me'))),
      seen(
        `GET /api/no-such-route-${randomUUID()}`,
        fetch(url(`/api/no-such-route-${randomUUID()}`)),
      ),
      seen(
        'POST /api/cart/items with a body that is not JSON',
        fetch(url('/api/cart/items'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...pair },
          body: '{"variantId": ',
        }),
      ),
    ])
    // Each answer is the kind it names, so a no-store on it is the rule's and not a different route's.
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 403, 401, 404, 400])
    // One no-store per answer: the header list is the answer list with every entry no-store.
    expect(
      answers.map((a) => a.cacheControl),
      `not no-store: ${listed(answers.filter((a) => a.cacheControl !== 'no-store'))}`,
    ).toEqual(answers.map(() => 'no-store'))
  })

  it('AC-8: a route’s own Cache-Control is kept (recently viewed, the event stream), and /health and /admin/ carry no no-store, while a route with none of its own gets no-store', async () => {
    const admin = await adminClient(k, served.baseUrl)
    const ticket = await admin.call<{ ticket: string }>('POST', '/api/admin/events/ticket')
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(200)

    const plain = await seen('GET /api/products', fetch(url('/api/products')))
    const recentlyViewed = await seen(
      'GET /api/recently-viewed',
      fetch(url('/api/recently-viewed')),
    )
    const abort = new AbortController()
    const stream = await fetch(
      url(`/api/admin/events?ticket=${encodeURIComponent(ticket.body.data!.ticket)}`),
      { signal: abort.signal, headers: { accept: 'text/event-stream' } },
    )
    const streamCacheControl = stream.headers.get('cache-control')
    abort.abort()
    const health = await seen('GET /health', fetch(url('/health')))
    const adminPage = await seen('GET /admin/', fetch(url('/admin/')))

    expect(recentlyViewed.cacheControl).toBe('private, no-store')
    expect(streamCacheControl).toBe('no-cache, no-transform')
    const outside = [health, adminPage].filter((a) => (a.cacheControl ?? '').includes('no-store'))
    expect(outside, listed(outside)).toEqual([])
    // The default is in force on this store, and the kept values are the routes' own, not the default's.
    expect(plain.cacheControl).toBe('no-store')
    expect(recentlyViewed.cacheControl).not.toBe(plain.cacheControl)
  })
})
