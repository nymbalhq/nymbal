import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { JOURNEY_STEPS, runJourney, type JourneyStep, type StepResult } from './journey.js'

// The smoke journey against an in-process store on loopback: an API, a storefront on another origin, and a third
// origin standing for a CDN. The fake behaves as a healthy store does unless a case breaks one thing: it demands the
// double-submit CSRF pair on every POST, keeps the cart by cookie, refuses a sold-out variant, settles the order and
// its stock a moment after checkout (as the projections do), and lets only the token login issued read admin orders.
// Each request is filed under the first step that may make it, so a case can tell which steps the journey reached.

const ADMIN = { email: 'verify-admin@nymbal.local', password: 'verify-admin-password-0123' }
/** Quick bounds for the fake: nothing it does takes longer than a few milliseconds. */
const FAST = { requestTimeoutMs: 2_000, settleTimeoutMs: 1_000, pollIntervalMs: 20 }
const STEP_INDEX = new Map<JourneyStep, number>(
  JOURNEY_STEPS.map((step: JourneyStep, i: number) => [step, i]),
)

type Origin = 'api' | 'storefront' | 'elsewhere'
interface Seen {
  origin: Origin
  method: string
  path: string
  step: JourneyStep | null
  authorization: string | null
  /** A POST's JSON body, once read. */
  body?: Record<string, unknown>
}
interface PageFault {
  status?: number
  type?: string
  body?: string
}
interface FakeOptions {
  productName?: string
  /** The product page's markup for the name, raw by default. */
  renderName?: (name: string) => string
  /** The status the step's own request answers with (health, home, product page, cart, checkout, order read, admin page). */
  failAt?: { step: JourneyStep; status: number }
  /** The step whose own request is accepted and never answered. */
  hang?: JourneyStep
  home?: PageFault
  product?: PageFault
  admin?: PageFault
  /** Per script path on the storefront: what it answers instead of 200 JavaScript. */
  scripts?: Record<string, { status?: number; type?: string }>
  /** Stock after checkout minus stock before: -1 for one unit taken. */
  stockDelta?: number
  confirms?: boolean
  roles?: string[]
  /** Admin orders lists the new order from this read on (1 is the first); Infinity never. */
  adminListsFromRead?: number
  /** How long after checkout the order and its stock settle. */
  settleMs?: number
}
interface FakeStore {
  apiUrl: string
  storefrontUrl: string
  elsewhereUrl: string
  requests: Seen[]
  issuedToken: () => string | null
  orderNumber: () => string | null
  close(): Promise<void>
}

const HOME_SCRIPTS = ['/_astro/home.4f2a.js', '/_astro/shared.91bc.js']
const PRODUCT_SCRIPTS = ['/_astro/product.7d1e.js']
const START_STOCK = 7

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
function page(res: ServerResponse, fault: PageFault | undefined, html: string) {
  res.writeHead(fault?.status ?? 200, { 'content-type': fault?.type ?? 'text/html; charset=utf-8' })
  res.end(fault?.body ?? html)
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** The first step that may make a request: what a journey that stopped at step k must not have sent past k. */
function stepOf(origin: Origin, method: string, path: string): JourneyStep | null {
  if (origin === 'api') {
    if (method === 'GET' && path === '/health') return 'health'
    if (method === 'GET' && path.startsWith('/api/products')) return 'product'
    if (method === 'POST' && path === '/api/cart/items') return 'cart'
    if (method === 'POST' && path === '/api/checkout') return 'checkout'
    if (method === 'GET' && path.startsWith('/api/orders/')) return 'order'
    if (path.startsWith('/admin') || path === '/api/auth/login' || path.startsWith('/api/admin/'))
      return 'admin'
    return null
  }
  if (origin === 'storefront') {
    if (path === '/' || HOME_SCRIPTS.includes(path)) return 'home'
    if (path.startsWith('/product/') || PRODUCT_SCRIPTS.includes(path)) return 'product'
    return null
  }
  return null
}

/** The request that is each step's own: the one `failAt` and `hang` act on. */
const OWN: Record<JourneyStep, (origin: Origin, method: string, path: string) => boolean> = {
  health: (origin, _method, path) => origin === 'api' && path === '/health',
  home: (origin, _method, path) => origin === 'storefront' && path === '/',
  product: (origin, _method, path) => origin === 'storefront' && path.startsWith('/product/'),
  cart: (origin, method, path) =>
    origin === 'api' && method === 'POST' && path === '/api/cart/items',
  checkout: (origin, method, path) =>
    origin === 'api' && method === 'POST' && path === '/api/checkout',
  order: (origin, _method, path) => origin === 'api' && path.startsWith('/api/orders/'),
  admin: (origin, _method, path) => origin === 'api' && (path === '/admin/' || path === '/admin'),
}
const isStepsOwn = (step: JourneyStep, origin: Origin, method: string, path: string): boolean =>
  OWN[step](origin, method, path)

const open: FakeStore[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()))
})

async function fakeStore(opts: FakeOptions = {}): Promise<FakeStore> {
  const name = opts.productName ?? 'Linen Apron'
  const requests: Seen[] = []
  const servers: Server[] = []
  const carts = new Map<string, Array<{ variantId: string; qty: number }>>()
  const stock = START_STOCK
  let checkedOutAt: number | null = null
  let order: { number: string; key: string } | null = null
  let token: string | null = null
  let adminReads = 0
  const settled = () => checkedOutAt !== null && Date.now() - checkedOutAt >= (opts.settleMs ?? 60)
  const products = () => [
    {
      id: 'p-0',
      slug: 'sold-out-lamp',
      name: 'Sold Out Lamp',
      variants: [{ id: 'v-0', stock: 0 }],
    },
    {
      id: 'p-1',
      slug: 'linen-apron',
      name,
      variants: [
        { id: 'v-1', stock: settled() ? stock + (opts.stockDelta ?? -1) : stock },
        { id: 'v-2', stock: 3 },
      ],
    },
  ]

  /** Records the request; answers it here when the case fails or hangs it (null), else returns its record. */
  const intercept = (origin: Origin, req: IncomingMessage, res: ServerResponse): Seen | null => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const method = req.method ?? 'GET'
    const seen: Seen = {
      origin,
      method,
      path: url.pathname,
      step: stepOf(origin, method, url.pathname),
      authorization: req.headers.authorization ?? null,
    }
    requests.push(seen)
    if (opts.hang !== undefined && isStepsOwn(opts.hang, origin, method, url.pathname)) return null
    if (opts.failAt !== undefined && isStepsOwn(opts.failAt.step, origin, method, url.pathname)) {
      json(res, opts.failAt.status, { error: { code: 'fake.fault', message: 'injected' } })
      return null
    }
    return seen
  }

  const csrfOk = (req: IncomingMessage) => {
    const pair = cookies(req).get('nymbal.csrf')
    return pair !== undefined && pair !== '' && req.headers['x-csrf-token'] === pair
  }

  const elsewhere = await listen((req, res) => {
    intercept('elsewhere', req, res)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not here')
  })
  servers.push(elsewhere)

  const storefront = await listen((req, res) => {
    if (intercept('storefront', req, res) === null) return
    const path = new URL(req.url ?? '/', 'http://fake').pathname
    const self = urlOf(storefront)
    if (path === '/') {
      return page(
        res,
        opts.home,
        `<!doctype html><html><head><title>Shop</title>` +
          `<script type="module" src="${HOME_SCRIPTS[0]}"></script>` +
          `<script type="module" src="${self}${HOME_SCRIPTS[1]}"></script>` +
          `<script async src="${urlOf(elsewhere)}/analytics.js"></script>` +
          `</head><body><h1>Shop</h1><a href="/product/linen-apron">Apron</a></body></html>`,
      )
    }
    const slug = /^\/product\/([^/]+)$/.exec(path)?.[1]
    if (slug !== undefined) {
      const found = products().find((p) => p.slug === slug)
      if (found === undefined) return page(res, { status: 404 }, '<p>Not found</p>')
      return page(
        res,
        opts.product,
        `<!doctype html><html><head><title>Product</title>` +
          `<script type="module" src="${PRODUCT_SCRIPTS[0]}"></script>` +
          `<script src="${urlOf(elsewhere)}/widget.js"></script>` +
          `</head><body><h1>${(opts.renderName ?? ((n) => n))(found.name)}</h1></body></html>`,
      )
    }
    if ([...HOME_SCRIPTS, ...PRODUCT_SCRIPTS].includes(path)) {
      const fault = opts.scripts?.[path]
      // One JavaScript type each way the spec allows, so both are seen as scripts.
      const type =
        path === HOME_SCRIPTS[1] ? 'application/javascript' : 'text/javascript; charset=utf-8'
      res.writeHead(fault?.status ?? 200, { 'content-type': fault?.type ?? type })
      return res.end('export {}\n')
    }
    page(res, { status: 404 }, '<p>Not found</p>')
  })
  servers.push(storefront)

  const api = await listen((req, res) => {
    const seen = intercept('api', req, res)
    if (seen === null) return
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const path = url.pathname
      const method = req.method ?? 'GET'
      const body = method === 'POST' ? await bodyOf(req) : {}
      if (method === 'POST') seen.body = body
      if (method === 'POST' && !csrfOk(req)) {
        return json(res, 403, { error: { code: 'csrf.invalid', message: 'CSRF token missing' } })
      }
      if (method === 'GET' && path === '/health')
        return json(res, 200, { status: 'ok', version: '1.8.0' })
      if (method === 'GET' && path === '/api/products') {
        return json(res, 200, { data: { items: products(), nextCursor: null } })
      }
      const one = /^\/api\/products\/([^/]+)$/.exec(path)?.[1]
      if (method === 'GET' && one !== undefined) {
        const found = products().find((p) => p.slug === one || p.id === one)
        return found === undefined
          ? json(res, 404, { error: { code: 'products.not_found', message: one } })
          : json(res, 200, { data: found })
      }
      if (method === 'POST' && path === '/api/cart/items') {
        const variantId = String(body['variantId'])
        const qty = Number(body['qty'])
        const variant = products()
          .flatMap((p) => p.variants)
          .find((v) => v.id === variantId)
        if (variant === undefined)
          return json(res, 404, { error: { code: 'cart.variant_missing', message: variantId } })
        if (!(qty >= 1) || variant.stock < qty) {
          return json(res, 409, { error: { code: 'cart.out_of_stock', message: variantId } })
        }
        const id = cookies(req).get('nymbal.cart') ?? randomBytes(6).toString('hex')
        carts.set(id, [...(carts.get(id) ?? []), { variantId, qty }])
        return json(
          res,
          200,
          { data: { id, items: carts.get(id) } },
          { 'set-cookie': `nymbal.cart=${id}; Path=/; HttpOnly; SameSite=Lax` },
        )
      }
      if (method === 'POST' && path === '/api/checkout') {
        const cart = carts.get(cookies(req).get('nymbal.cart') ?? '') ?? []
        if (cart.length === 0)
          return json(res, 409, { error: { code: 'checkout.cart_empty', message: 'empty' } })
        if (typeof body['email'] !== 'string' || !String(body['email']).includes('@')) {
          return json(res, 400, { error: { code: 'checkout.invalid', message: 'email required' } })
        }
        order = {
          number: String(1000 + Math.floor(Math.random() * 9000)),
          key: randomBytes(8).toString('hex'),
        }
        checkedOutAt = Date.now()
        return json(res, 200, { data: { orderNumber: order.number, orderKey: order.key } })
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
        const status = settled() && (opts.confirms ?? true) ? 'confirmed' : 'pending'
        return json(res, 200, { data: { orderNumber: order.number, status } })
      }
      if (method === 'GET' && (path === '/admin/' || path === '/admin')) {
        return page(
          res,
          opts.admin,
          '<!doctype html><html><body><div id="root"></div></body></html>',
        )
      }
      if (method === 'POST' && path === '/api/auth/login') {
        if (body['email'] !== ADMIN.email || body['password'] !== ADMIN.password) {
          return json(res, 401, { error: { code: 'auth.invalid_credentials', message: 'no' } })
        }
        token = `tok-${randomBytes(8).toString('hex')}`
        return json(res, 200, {
          data: {
            customer: { id: 'c-1', email: ADMIN.email, roles: opts.roles ?? ['customer', 'admin'] },
            accessToken: token,
            expiresIn: 900,
          },
        })
      }
      if (method === 'GET' && path === '/api/admin/orders') {
        if (token === null || req.headers.authorization !== `Bearer ${token}`) {
          return json(res, 401, { error: { code: 'auth.unauthorized', message: 'sign in' } })
        }
        adminReads += 1
        const listed =
          order !== null && adminReads >= (opts.adminListsFromRead ?? 1)
            ? [{ id: 'o-1', orderNumber: order.number, status: 'confirmed' }]
            : []
        return json(res, 200, { data: listed, meta: { total: listed.length } })
      }
      json(res, 404, { error: { code: 'not_found', message: path } })
    })()
  })
  servers.push(api)

  const fake: FakeStore = {
    apiUrl: urlOf(api),
    storefrontUrl: urlOf(storefront),
    elsewhereUrl: urlOf(elsewhere),
    requests,
    issuedToken: () => token,
    orderNumber: () => order?.number ?? null,
    async close() {
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  }
  open.push(fake)
  return fake
}

const target = (fake: FakeStore) => ({
  apiUrl: fake.apiUrl,
  storefrontUrl: fake.storefrontUrl,
  admin: ADMIN,
})
const stepNamed = (results: StepResult[], step: JourneyStep) => results.find((r) => r.step === step)
/** The furthest step any request the fake received belongs to, as an index into JOURNEY_STEPS; -1 for none. */
const furthest = (seen: Seen[]) =>
  Math.max(-1, ...seen.map((r) => (r.step === null ? -1 : STEP_INDEX.get(r.step)!)))

// ─── AC-1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-1: a healthy store', () => {
  it('AC-1: runJourney returns the seven steps in order, all ok, and onStep reports each as it finishes, before the next step sends anything', async () => {
    const fake = await fakeStore()
    const reported: Array<{ result: StepResult; requestsSoFar: number }> = []

    const results = await runJourney(target(fake), {
      ...FAST,
      onStep: (result) => reported.push({ result, requestsSoFar: fake.requests.length }),
    })

    expect(results.map((r) => r.step)).toEqual([...JOURNEY_STEPS])
    expect(
      results.filter((r) => !r.ok),
      JSON.stringify(results),
    ).toEqual([])
    expect(reported.map((r) => r.result)).toEqual(results)
    // When onStep fires for step i, no request of a later step has been sent: results arrive as the journey runs.
    reported.forEach(({ result, requestsSoFar }, i) => {
      expect(furthest(fake.requests.slice(0, requestsSoFar)), result.step).toBeLessThanOrEqual(i)
    })
    // Each step's own request reaches the store after the previous step's: no step runs out of order.
    const firstOwn = JOURNEY_STEPS.map((step) =>
      fake.requests.findIndex((r) => isStepsOwn(step, r.origin, r.method, r.path)),
    )
    for (let i = 1; i < firstOwn.length; i++) {
      expect(firstOwn[i], `${JOURNEY_STEPS[i]} after ${JOURNEY_STEPS[i - 1]}`).toBeGreaterThan(
        firstOwn[i - 1]!,
      )
    }
  })

  it('AC-1: the cart gets the first product whose first variant has stock, not the sold-out one listed before it', async () => {
    const fake = await fakeStore()

    const results = await runJourney(target(fake), FAST)

    expect(stepNamed(results, 'cart')?.ok, JSON.stringify(results)).toBe(true)
    const carted = fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/cart/items')
    expect(carted.map((r) => r.body)).toEqual([{ variantId: 'v-1', qty: 1 }])
  })
})

// ─── AC-2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-2: the journey stops at the first failed step', () => {
  it('AC-2: for any step k and any error status, a store failing exactly step k gives k results, k-1 ok, the k-th failed naming the status, and no request of a later step', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: JOURNEY_STEPS.length }),
        fc.constantFrom(404, 500, 502, 503),
        async (k, status) => {
          const step = JOURNEY_STEPS[k - 1]!
          const fake = await fakeStore({ failAt: { step, status } })

          const results = await runJourney(target(fake), { ...FAST, settleTimeoutMs: 200 })

          expect(results.map((r) => r.step)).toEqual(JOURNEY_STEPS.slice(0, k))
          expect(results.slice(0, k - 1).filter((r) => !r.ok)).toEqual([])
          expect(results[k - 1]!.ok).toBe(false)
          expect(results[k - 1]!.detail).toContain(String(status))
          expect(
            furthest(fake.requests),
            `${step} failed, yet a later step was sent`,
          ).toBeLessThanOrEqual(k - 1)
          await fake.close()
        },
      ),
      { numRuns: 28 },
    )
  }, 60_000)
})

// ─── AC-3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-3: what the pages must be', () => {
  it('AC-3: home fails on a 200 whose content type is not HTML', async () => {
    const fake = await fakeStore({
      home: { type: 'application/json', body: '{"error":"render failed"}' },
    })

    const results = await runJourney(target(fake), FAST)

    expect(results.map((r) => [r.step, r.ok])).toEqual([
      ['health', true],
      ['home', false],
    ])
  })

  it("AC-3: product fails on a 200 HTML page that lacks the product's name", async () => {
    const fake = await fakeStore({
      product: { body: '<!doctype html><h1>Something went wrong</h1>' },
    })

    const results = await runJourney(target(fake), FAST)

    expect(results.map((r) => [r.step, r.ok])).toEqual([
      ['health', true],
      ['home', true],
      ['product', false],
    ])
  })

  it('AC-3: for any name with &, quotes or angle brackets, product passes when the page holds the name only HTML-escaped', async () => {
    const apostrophes = ['&#39;', '&#x27;']
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z][A-Za-z &'"<>]{0,18}[&'"<>][A-Za-z ]{0,6}[A-Za-z]$/),
        fc.constantFrom(...apostrophes),
        async (name, apostrophe) => {
          const fake = await fakeStore({
            productName: name,
            renderName: (n) => escapeHtml(n).replace(/&#39;/g, apostrophe),
          })

          const results = await runJourney(target(fake), FAST)

          expect(stepNamed(results, 'product')?.ok, `${name}: ${JSON.stringify(results)}`).toBe(
            true,
          )
          await fake.close()
        },
      ),
      { numRuns: 25 },
    )
  }, 60_000)

  for (const [page, script] of [
    ['home', HOME_SCRIPTS[0]!],
    ['home', HOME_SCRIPTS[1]!],
    ['product', PRODUCT_SCRIPTS[0]!],
  ] as const) {
    for (const [why, fault] of [
      ['answers 404', { status: 404, type: 'text/html' }],
      ['is served as text/html', { status: 200, type: 'text/html; charset=utf-8' }],
    ] as const) {
      it(`AC-3: ${page} fails naming ${script} when that same-origin script ${why}`, async () => {
        const fake = await fakeStore({ scripts: { [script]: fault } })

        const results = await runJourney(target(fake), FAST)

        const failed = results.at(-1)!
        expect([failed.step, failed.ok]).toEqual([page, false])
        expect(failed.detail).toContain(script)
      })
    }
  }

  it('AC-3: a script on another origin is never fetched, so its 404 fails neither page', async () => {
    const fake = await fakeStore()

    const results = await runJourney(target(fake), FAST)

    expect(results.filter((r) => !r.ok)).toEqual([])
    const sameOrigin = fake.requests.filter(
      (r) => r.origin === 'storefront' && [...HOME_SCRIPTS, ...PRODUCT_SCRIPTS].includes(r.path),
    )
    expect(new Set(sameOrigin.map((r) => r.path))).toEqual(
      new Set([...HOME_SCRIPTS, ...PRODUCT_SCRIPTS]),
    )
    expect(fake.requests.filter((r) => r.origin === 'elsewhere')).toEqual([])
  })
})

// ─── AC-4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-4: the order takes exactly one unit of stock', () => {
  it('AC-4: for any stock change d in -3..+3 and either confirmation, order is ok exactly when the order reads confirmed and d = -1', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -3, max: 3 }), fc.boolean(), async (d, confirms) => {
        const fake = await fakeStore({ stockDelta: d, confirms })

        const results = await runJourney(target(fake), { ...FAST, settleTimeoutMs: 300 })

        const order = stepNamed(results, 'order')
        expect(order, JSON.stringify(results)).not.toBeUndefined()
        expect(order!.ok, `d=${d} confirms=${confirms}: ${order!.detail}`).toBe(
          confirms && d === -1,
        )
        await fake.close()
      }),
      { numRuns: 25 },
    )
  }, 60_000)

  it('AC-4: an order that stays unconfirmed fails once settleTimeoutMs has passed, not before', async () => {
    const fake = await fakeStore({ confirms: false })
    const finished: Partial<Record<JourneyStep, number>> = {}

    const results = await runJourney(target(fake), {
      ...FAST,
      settleTimeoutMs: 600,
      onStep: (r) => (finished[r.step] = performance.now()),
    })

    expect(results.map((r) => [r.step, r.ok]).at(-1)).toEqual(['order', false])
    const waited = finished.order! - finished.checkout!
    expect(waited).toBeGreaterThanOrEqual(600 - 50)
    expect(waited).toBeLessThan(600 + FAST.requestTimeoutMs + 1_000)
    // It polled: the order was read more than once in that time.
    expect(fake.requests.filter((r) => r.step === 'order').length).toBeGreaterThan(1)
  })
})

// ─── AC-5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-5: the admin signs in and sees the order', () => {
  it("AC-5: admin orders is read with the login's bearer token and lists the order once it settles", async () => {
    const fake = await fakeStore({ adminListsFromRead: 2 })

    const results = await runJourney(target(fake), FAST)

    expect(stepNamed(results, 'admin')?.ok, JSON.stringify(results)).toBe(true)
    const reads = fake.requests.filter((r) => r.path === '/api/admin/orders')
    expect(reads.length).toBeGreaterThanOrEqual(2)
    expect(new Set(reads.map((r) => r.authorization))).toEqual(
      new Set([`Bearer ${fake.issuedToken()}`]),
    )
  })

  const broken: Array<[string, FakeOptions]> = [
    ['/admin/ is not HTML', { admin: { type: 'application/json', body: '{}' } }],
    ["login's roles lack admin", { roles: ['customer'] }],
    ['admin orders never lists the order', { adminListsFromRead: Infinity }],
  ]
  for (const [why, opts] of broken) {
    it(`AC-5: admin fails when ${why}`, async () => {
      const fake = await fakeStore(opts)

      const results = await runJourney(target(fake), { ...FAST, settleTimeoutMs: 300 })

      expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, true, false])
      expect(results.at(-1)!.step).toBe('admin')
    })
  }
})

// ─── AC-6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-6: nothing hangs and nothing throws', () => {
  it('AC-6: for a store that accepts and never answers one step, that step fails within requestTimeoutMs plus one second and runJourney resolves', async () => {
    const requestTimeoutMs = 400
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<JourneyStep>('health', 'home', 'product', 'cart', 'checkout', 'admin'),
        async (step) => {
          const fake = await fakeStore({ hang: step })
          const k = STEP_INDEX.get(step)!
          let previousAt = performance.now()
          const took: number[] = []

          const results = await runJourney(target(fake), {
            ...FAST,
            requestTimeoutMs,
            onStep: () => {
              const now = performance.now()
              took.push(now - previousAt)
              previousAt = now
            },
          })

          expect(results.map((r) => r.step)).toEqual(JOURNEY_STEPS.slice(0, k + 1))
          expect(results[k]!.ok).toBe(false)
          expect(took[k], `${step} took ${took[k]} ms`).toBeLessThan(requestTimeoutMs + 1_000)
          await fake.close()
        },
      ),
      { numRuns: 12 },
    )
  }, 60_000)

  it('AC-6: a fetch that throws or rejects becomes that step’s failure, with its message, and runJourney resolves', async () => {
    for (const how of ['rejects', 'throws'] as const) {
      const fake = await fakeStore()
      const broken: typeof fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/api/checkout')) {
          if (how === 'throws') throw new TypeError('fetch failed: socket hang up')
          return Promise.reject(new TypeError('fetch failed: socket hang up'))
        }
        return fetch(input, init)
      }

      const results = await runJourney(target(fake), { ...FAST, fetch: broken })

      expect(results.map((r) => [r.step, r.ok]).at(-1), how).toEqual(['checkout', false])
      expect(results.at(-1)!.detail, how).toContain('socket hang up')
      expect(
        results.slice(0, -1).filter((r) => !r.ok),
        how,
      ).toEqual([])
    }
  })

  it('AC-6: nothing listening at the API fails health with a detail and resolves', async () => {
    const fake = await fakeStore()
    await fake.close()

    const results = await runJourney(target(fake), FAST)

    expect(results.map((r) => [r.step, r.ok])).toEqual([['health', false]])
    expect(results[0]!.detail.length).toBeGreaterThan(0)
  })
})
