import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { runStoreCheck } from './index.js'

// The heartbeat's store check against an in-process store on loopback: an API and a storefront. Like the kernel, the
// fake API demands the double-submit CSRF pair on every POST, keeps the cart by cookie, quotes a total with paid
// shipping and tax on top, and refuses a checkout whose total or option is not the one it quoted. It recognises the
// heartbeat address (case-blind, trimmed) and answers 409 checkout.synthetic naming a cancelled order; told not to, it
// places an ordinary order and answers 200. Each request is filed under the first step that may make it, so a case can
// tell which steps the check reached.

const STEPS = ['health', 'home', 'product', 'cart', 'quote', 'checkout', 'order'] as const
type Step = (typeof STEPS)[number]

const HEARTBEAT = 'Heartbeat.Ops+Monitor@Shop.Example'
const ADDRESS = {
  firstName: 'Heartbeat',
  lastName: 'Check',
  company: 'Shop Ltd',
  addressLine1: '9 Monitor Row',
  addressLine2: 'Unit 2',
  city: 'Leeds',
  region: 'West Yorkshire',
  postalCode: 'LS1 4AP',
  country: 'GB',
  phone: '+441130000000',
}
const SHIPPING_MINOR = 450
const FAST = { requestTimeoutMs: 2_000 }

type Origin = 'api' | 'storefront'
interface Seen {
  origin: Origin
  method: string
  path: string
  step: Step | null
  body?: Record<string, unknown>
}
interface FakeOptions {
  /** Every request of this step answers `status`. */
  failAt?: { step: Step; status: number }
  /** False: the store does not know the heartbeat address and places an ordinary order. */
  recognises?: boolean
  /** The status the order read reports; cancelled by default. */
  orderStatus?: string
}
interface FakeStore {
  apiUrl: string
  storefrontUrl: string
  requests: Seen[]
  /** The option and total the last quote answered. */
  quoted: () => { optionId: string; totalMinor: number } | null
  orderNumber: () => string | null
  close(): Promise<void>
}

interface Variant {
  id: string
  sku: string
  stock: number
  priceMinor: number
}
interface Product {
  id: string
  slug: string
  name: string
  variants: Variant[]
}

/** The first product's first variant is sold out (its second is not); the second product's first variant is the
 * default pick; the configured sku is a later product's second variant. */
const PRODUCTS: Product[] = [
  {
    id: 'p-0',
    slug: 'sold-out-lamp',
    name: 'Sold Out Lamp',
    variants: [
      { id: 'v-0a', sku: 'LAMP-A', stock: 0, priceMinor: 900 },
      { id: 'v-0b', sku: 'LAMP-B', stock: 6, priceMinor: 900 },
    ],
  },
  {
    id: 'p-1',
    slug: 'linen-apron',
    name: 'Linen Apron',
    variants: [{ id: 'v-1', sku: 'APRON', stock: 4, priceMinor: 1_250 }],
  },
  {
    id: 'p-2',
    slug: 'oak-board',
    name: 'Oak Board',
    variants: [
      { id: 'v-2a', sku: 'BOARD-S', stock: 2, priceMinor: 2_000 },
      { id: 'v-2b', sku: 'HEARTBEAT-SKU', stock: 9, priceMinor: 3_100 },
    ],
  },
]
const VARIANTS = PRODUCTS.flatMap((p) => p.variants)

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`

function cookies(req: IncomingMessage): Map<string, string> {
  const jar = new Map<string, string>()
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return jar
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}
function html(res: ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>Shop</title></head><body>${body}</body></html>`)
}

function stepOf(origin: Origin, method: string, path: string): Step | null {
  if (origin === 'storefront') {
    if (path === '/') return 'home'
    if (path.startsWith('/product')) return 'product'
    return null
  }
  if (method === 'GET' && path === '/health') return 'health'
  if (method === 'GET' && path.startsWith('/api/products')) return 'product'
  if (method === 'POST' && path === '/api/cart/items') return 'cart'
  if (method === 'POST' && path === '/api/checkout/quote') return 'quote'
  if (method === 'POST' && path === '/api/checkout') return 'checkout'
  if (method === 'GET' && path.startsWith('/api/orders/')) return 'order'
  return null
}

const open: FakeStore[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()))
})

async function fakeStore(opts: FakeOptions = {}): Promise<FakeStore> {
  const requests: Seen[] = []
  const carts = new Map<string, Variant[]>()
  /** Per cart: the option and total its last quote answered. */
  const quotes = new Map<string, { optionId: string; totalMinor: number }>()
  let lastQuote: { optionId: string; totalMinor: number } | null = null
  let order: { number: string; key: string } | null = null

  const intercept = (origin: Origin, req: IncomingMessage, res: ServerResponse): Seen | null => {
    const path = new URL(req.url ?? '/', 'http://fake').pathname
    const method = req.method ?? 'GET'
    const seen: Seen = { origin, method, path, step: stepOf(origin, method, path) }
    requests.push(seen)
    if (opts.failAt !== undefined && seen.step === opts.failAt.step) {
      json(res, opts.failAt.status, { error: { code: 'fake.fault', message: 'injected' } })
      return null
    }
    return seen
  }

  const csrfOk = (req: IncomingMessage) => {
    const pair = cookies(req).get('nymbal.csrf')
    return pair !== undefined && pair !== '' && req.headers['x-csrf-token'] === pair
  }

  const storefront = await listen((req, res) => {
    const seen = intercept('storefront', req, res)
    if (seen === null) return
    if (seen.path === '/') {
      return html(res, PRODUCTS.map((p) => `<a href="/product/${p.slug}">${p.name}</a>`).join(''))
    }
    const slug = /^\/products?\/([^/]+)$/.exec(seen.path)?.[1]
    const found = PRODUCTS.find((p) => p.slug === slug)
    if (found === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' })
      return res.end('<p>Not found</p>')
    }
    return html(res, `<h1>${found.name}</h1>`)
  })

  const api = await listen((req, res) => {
    const seen = intercept('api', req, res)
    if (seen === null) return
    void (async () => {
      const { method, path } = seen
      const body = method === 'POST' ? await bodyOf(req) : {}
      if (method === 'POST') seen.body = body
      if (method === 'GET' && path === '/api/csrf') {
        const token = randomBytes(16).toString('hex')
        return json(res, 200, { data: { token } }, { 'set-cookie': `nymbal.csrf=${token}; Path=/` })
      }
      if (method === 'POST' && !csrfOk(req)) {
        return json(res, 403, { error: { code: 'csrf.invalid', message: 'CSRF token missing' } })
      }
      if (method === 'GET' && path === '/health')
        return json(res, 200, { status: 'ok', version: '1.8.0' })
      if (method === 'GET' && path === '/api/products') {
        return json(res, 200, { data: { items: PRODUCTS, nextCursor: null } })
      }
      const one = /^\/api\/products\/([^/]+)$/.exec(path)?.[1]
      if (method === 'GET' && one !== undefined) {
        const found = PRODUCTS.find((p) => p.slug === one || p.id === one)
        return found === undefined
          ? json(res, 404, { error: { code: 'products.not_found', message: one } })
          : json(res, 200, { data: found })
      }
      const cartId = cookies(req).get('nymbal.cart') ?? ''
      if (method === 'POST' && path === '/api/cart/items') {
        const variant = VARIANTS.find((v) => v.id === body['variantId'])
        const qty = Number(body['qty'])
        if (variant === undefined) {
          return json(res, 404, {
            error: { code: 'cart.variant_missing', message: String(body['variantId']) },
          })
        }
        if (!(qty >= 1) || variant.stock < qty) {
          return json(res, 409, { error: { code: 'cart.out_of_stock', message: variant.id } })
        }
        const id = cartId !== '' ? cartId : randomBytes(6).toString('hex')
        carts.set(id, [...(carts.get(id) ?? []), ...Array.from({ length: qty }, () => variant)])
        return json(
          res,
          200,
          { data: { token: id, items: carts.get(id)!.map((v) => ({ variantId: v.id, qty: 1 })) } },
          { 'set-cookie': `nymbal.cart=${id}; Path=/; HttpOnly; SameSite=Lax` },
        )
      }
      const cart = carts.get(cartId) ?? []
      if (method === 'POST' && path === '/api/checkout/quote') {
        if (cart.length === 0)
          return json(res, 400, { error: { code: 'checkout.no_cart', message: 'No cart' } })
        const goods = cart.reduce((sum, v) => sum + v.priceMinor, 0)
        const taxMinor = Math.round((goods + SHIPPING_MINOR) * 0.2)
        // A fresh option id per quote, so a checkout that names any other was not quoted.
        const optionId = `ship-${randomBytes(3).toString('hex')}`
        const quoted = { optionId, totalMinor: goods + SHIPPING_MINOR + taxMinor }
        quotes.set(cartId, quoted)
        lastQuote = quoted
        return json(res, 200, {
          data: {
            currency: 'GBP',
            options: [
              { id: optionId, name: 'Standard', amountMinor: SHIPPING_MINOR, estimatedDays: 3 },
              { id: 'collect', name: 'Collect', amountMinor: 0, estimatedDays: null },
            ],
            shippingOptionId: optionId,
            totals: {
              currency: 'GBP',
              subtotalMinor: goods,
              shippingTotalMinor: SHIPPING_MINOR,
              taxTotalMinor: taxMinor,
              discountTotalMinor: 0,
              totalMinor: quoted.totalMinor,
            },
          },
        })
      }
      if (method === 'POST' && path === '/api/checkout') {
        if (cart.length === 0)
          return json(res, 409, { error: { code: 'checkout.cart_empty', message: 'empty' } })
        const quoted = quotes.get(cartId)
        if (
          quoted === undefined ||
          body['expectedTotalMinor'] !== quoted.totalMinor ||
          body['shippingOptionId'] !== quoted.optionId
        ) {
          return json(res, 409, {
            error: {
              code: 'checkout.total_changed',
              message: 'The total changed',
              context: { totalMinor: quoted?.totalMinor },
            },
          })
        }
        order = {
          number: `HB${1000 + Math.floor(Math.random() * 9000)}`,
          key: randomBytes(8).toString('hex'),
        }
        const email = String(body['email'] ?? '')
          .trim()
          .toLowerCase()
        if ((opts.recognises ?? true) && email === HEARTBEAT.toLowerCase()) {
          return json(res, 409, {
            error: {
              code: 'checkout.synthetic',
              message: 'A heartbeat checkout: the order was placed and cancelled',
              context: { orderNumber: order.number, orderKey: order.key },
            },
          })
        }
        return json(res, 200, {
          data: {
            orderId: 'o-1',
            orderNumber: order.number,
            orderKey: order.key,
            totalMinor: quoted.totalMinor,
          },
        })
      }
      const n = /^\/api\/orders\/([^/]+)$/.exec(path)?.[1]
      if (method === 'GET' && n !== undefined) {
        if (
          order === null ||
          n !== order.number ||
          req.headers['x-nymbal-order-key'] !== order.key
        ) {
          return json(res, 404, { error: { code: 'orders.not_found', message: n } })
        }
        return json(res, 200, {
          data: { orderNumber: order.number, status: opts.orderStatus ?? 'cancelled' },
        })
      }
      json(res, 404, { error: { code: 'not_found', message: path } })
    })()
  })

  const fake: FakeStore = {
    apiUrl: urlOf(api),
    storefrontUrl: urlOf(storefront),
    requests,
    quoted: () => lastQuote,
    orderNumber: () => order?.number ?? null,
    async close() {
      for (const server of [api, storefront]) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  }
  open.push(fake)
  return fake
}

const target = (fake: FakeStore, over: { storefront?: boolean; sku?: string } = {}) => ({
  apiUrl: fake.apiUrl,
  ...(over.storefront !== false && { storefrontUrl: fake.storefrontUrl }),
  email: HEARTBEAT,
  ...(over.sku !== undefined && { sku: over.sku }),
  address: ADDRESS,
})

const bodiesOf = (fake: FakeStore, step: Step) =>
  fake.requests.filter((r) => r.step === step && r.method === 'POST').map((r) => r.body!)

describe('AC-10: the store check against a store like the kernel', () => {
  // Kills: an unquoted total (refused on every store with shipping or tax on top), another address or a changed one, a
  // wrong variant, a pass on a store that never recognised the check.
  it('AC-10: on a healthy store the check is ok with the order number; the quote and checkout carry exactly H and the configured address as billing and shipping, and the checkout the quoted total and option; the cart gets one unit of the first product whose first variant has stock', async () => {
    const fake = await fakeStore()
    const result = await runStoreCheck(target(fake), FAST)

    expect(
      { check: result.check, status: result.status, step: result.step },
      result.detail,
    ).toEqual({
      check: 'store',
      status: 'ok',
      step: undefined,
    })
    expect(result.orderNumber).toBe(fake.orderNumber())
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(Date.parse(result.startedAt)).toBeLessThanOrEqual(Date.now())

    expect(bodiesOf(fake, 'cart')).toEqual([{ variantId: 'v-1', qty: 1 }])
    const [quoteBody] = bodiesOf(fake, 'quote')
    expect(quoteBody).toMatchObject({ email: HEARTBEAT, shippingAddress: ADDRESS })
    const checkouts = bodiesOf(fake, 'checkout')
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0]).toMatchObject({
      email: HEARTBEAT,
      billingAddress: ADDRESS,
      shippingAddress: ADDRESS,
      expectedTotalMinor: fake.quoted()!.totalMinor,
      shippingOptionId: fake.quoted()!.optionId,
    })
  })

  // Kills: the configured sku ignored (the check exercises a variant the merchant did not choose).
  it('AC-10: with sku set the cart gets one unit of that variant, even when it is not a first variant', async () => {
    const fake = await fakeStore()
    const result = await runStoreCheck(target(fake, { sku: 'HEARTBEAT-SKU' }), FAST)
    expect(result.status, result.detail).toBe('ok')
    expect(bodiesOf(fake, 'cart')).toEqual([{ variantId: 'v-2b', qty: 1 }])
  })

  // Kills: page fetches against a storefront that is not configured (every run then fails on a store with no
  // storefront URL).
  it('AC-10: with no storefront URL no page is fetched and the check is still ok', async () => {
    const fake = await fakeStore()
    const result = await runStoreCheck(target(fake, { storefront: false }), FAST)
    expect(result.status, result.detail).toBe('ok')
    expect(fake.requests.filter((r) => r.origin === 'storefront')).toEqual([])
    expect(bodiesOf(fake, 'checkout')).toHaveLength(1)
  })

  // Kills: a pass on a store whose heartbeat order was not cancelled.
  it('AC-10: a refusal whose order then reads other than cancelled fails at order', async () => {
    const fake = await fakeStore({ orderStatus: 'confirmed' })
    const result = await runStoreCheck(target(fake), FAST)
    expect({ status: result.status, step: result.step }).toEqual({
      status: 'failed',
      step: 'order',
    })
  })

  // Kills: a check that passes on a broken store, reports the wrong step or no status, or keeps going after a failure.
  it('AC-10: property: for any step k and any failing status, the result is failed at k naming the status, and no request of a later step is sent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...STEPS),
        fc.constantFrom(400, 401, 403, 404, 409, 422, 429, 500, 502, 503),
        async (step, status) => {
          const fake = await fakeStore({ failAt: { step, status } })
          try {
            const result = await runStoreCheck(target(fake), FAST)
            expect({ status: result.status, step: result.step }).toEqual({ status: 'failed', step })
            expect(result.detail).toMatch(new RegExp(`\\b${status}\\b`))
            const later = STEPS.slice(STEPS.indexOf(step) + 1)
            expect(fake.requests.filter((r) => r.step !== null && later.includes(r.step))).toEqual(
              [],
            )
          } finally {
            await fake.close()
            open.splice(open.indexOf(fake), 1)
          }
        },
      ),
      { numRuns: 40 },
    )
  }, 60_000)
})

describe('AC-11: a store that does not know the heartbeat address', () => {
  // Kills: a real order placed by the heartbeat reported as ok or as an ordinary failure.
  it('AC-11: a checkout that answers 200 gives unrecognised naming the order number', async () => {
    const fake = await fakeStore({ recognises: false })
    const result = await runStoreCheck(target(fake), FAST)
    expect(result.status, result.detail).toBe('unrecognised')
    expect(result.orderNumber).toBe(fake.orderNumber())
    expect(result.detail).toContain(fake.orderNumber()!)
  })
})
