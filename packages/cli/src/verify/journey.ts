import { randomBytes } from 'node:crypto'

// The smoke journey `nymbal verify` runs over HTTP against a store and its storefront: no browser, no project access.
// Everything it needs comes through its arguments, so the command and its tests drive the same code.

export const JOURNEY_STEPS = [
  'health',
  'home',
  'product',
  'cart',
  'checkout',
  'order',
  'admin',
] as const
export type JourneyStep = (typeof JOURNEY_STEPS)[number]

export interface JourneyTarget {
  apiUrl: string
  storefrontUrl: string
  admin: { email: string; password: string }
}

export interface StepResult {
  step: JourneyStep
  ok: boolean
  detail: string
}

export interface JourneyOptions {
  fetch?: typeof fetch
  /** Per request; default 10 s. */
  requestTimeoutMs?: number
  /** Per polled read; default 15 s. */
  settleTimeoutMs?: number
  /** Between polled reads; default 1 s. The first read is immediate. */
  pollIntervalMs?: number
  /** Once per step, as it finishes. */
  onStep?: (result: StepResult) => void
}

/** A step that cannot pass: its message is the step's detail. */
class StepFailed extends Error {}

const ADDRESS = {
  firstName: 'Verify',
  lastName: 'Journey',
  addressLine1: '1 Verify Street',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

const JAVASCRIPT = /^(text|application)\/javascript\s*(;|$)/i
const HTML = /^text\/html\s*(;|$)/i

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
}
const unescapeHtml = (html: string) =>
  html.replace(/&(?:amp|lt|gt|quot|#39|#x27);/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const messageOf = (err: unknown): string => {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'no answer in time'
    const cause = (err as { cause?: unknown }).cause
    const why = cause instanceof Error && cause.message !== err.message ? `: ${cause.message}` : ''
    return `${err.message}${why}`
  }
  return String(err)
}

interface Answer {
  status: number
  type: string
  text: string
}

interface Product {
  id: string
  slug: string
  name: string
  variants?: Array<{ id: string; stock: number }>
}

/**
 * Runs the steps in order and stops after the first failure; never throws (an error is that step's detail).
 */
export async function runJourney(
  target: JourneyTarget,
  options: JourneyOptions = {},
): Promise<StepResult[]> {
  const doFetch = options.fetch ?? fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  const settleTimeoutMs = options.settleTimeoutMs ?? 15_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const storefrontOrigin = new URL(target.storefrontUrl).origin

  // The API's double-submit CSRF pair, and the cart cookie it sets.
  const csrf = randomBytes(32).toString('hex')
  const jar = new Map<string, string>([['nymbal.csrf', csrf]])

  /** One bounded request; the body is read within the same bound. */
  async function request(url: URL, init: RequestInit = {}): Promise<Answer> {
    const label = `${init.method ?? 'GET'} ${url.pathname}`
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) })
      const text = await res.text()
      return { status: res.status, type: res.headers.get('content-type') ?? '', text }
    } catch (err) {
      throw new StepFailed(`${label}: ${messageOf(err)}`)
    }
  }

  async function api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; data: unknown }> {
    const url = new URL(path, target.apiUrl)
    const label = `${method} ${url.pathname}`
    try {
      const res = await doFetch(url, {
        method,
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
          'x-csrf-token': csrf,
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      for (const set of res.headers.getSetCookie()) {
        const pair = set.split(';')[0] ?? ''
        const eq = pair.indexOf('=')
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
      }
      const text = await res.text()
      let data: unknown = null
      try {
        data = text === '' ? null : (JSON.parse(text) as { data?: unknown }).data
      } catch {
        data = null
      }
      return { status: res.status, data }
    } catch (err) {
      throw new StepFailed(`${label}: ${messageOf(err)}`)
    }
  }

  /** An API call that must answer 200; its `data`. */
  async function api200(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const answer = await api(method, path, body, headers)
    if (answer.status !== 200) {
      throw new StepFailed(
        `${method} ${new URL(path, target.apiUrl).pathname} answered ${answer.status}`,
      )
    }
    return answer.data
  }

  /** An HTML page that must answer 200 text/html. */
  async function htmlPage(url: URL): Promise<string> {
    const page = await request(url)
    if (page.status !== 200) throw new StepFailed(`GET ${url.pathname} answered ${page.status}`)
    if (!HTML.test(page.type)) {
      throw new StepFailed(`GET ${url.pathname} is ${page.type || 'untyped'}, not text/html`)
    }
    return page.text
  }

  /** Every same-origin `<script src>` the page names must be served as JavaScript; another origin's is not fetched. */
  async function scriptsServed(html: string, pageUrl: URL): Promise<number> {
    const sources = new Set<string>()
    for (const match of html.matchAll(
      /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )) {
      const src = match[1] ?? match[2] ?? match[3] ?? ''
      if (src === '') continue
      const url = new URL(src, pageUrl)
      if (url.origin === storefrontOrigin) sources.add(url.href)
    }
    for (const href of sources) {
      const url = new URL(href)
      const script = await request(url)
      if (script.status !== 200) {
        throw new StepFailed(`script ${url.pathname} answered ${script.status}`)
      }
      if (!JAVASCRIPT.test(script.type)) {
        throw new StepFailed(
          `script ${url.pathname} is ${script.type || 'untyped'}, not JavaScript`,
        )
      }
    }
    return sources.size
  }

  /** Reads at once, then every poll interval until `read` is satisfied or the settle bound passes. */
  async function settle(read: () => Promise<string | null>): Promise<void> {
    const start = Date.now()
    for (;;) {
      let why: string | null
      try {
        why = await read()
      } catch (err) {
        why = err instanceof Error ? err.message : String(err)
      }
      if (why === null) return
      const left = settleTimeoutMs - (Date.now() - start)
      if (left <= 0) throw new StepFailed(`after ${settleTimeoutMs / 1000} s, ${why}`)
      await sleep(Math.min(pollIntervalMs, left))
    }
  }

  let chosen: { product: Product; variantId: string; stockBefore: number } | null = null
  let order: { number: string; key: string } | null = null

  const run: Record<JourneyStep, () => Promise<string>> = {
    async health() {
      const data = await request(new URL('/health', target.apiUrl))
      if (data.status !== 200) throw new StepFailed(`GET /health answered ${data.status}`)
      let status: unknown
      try {
        status = (JSON.parse(data.text) as { status?: unknown }).status
      } catch {
        status = undefined
      }
      if (status !== 'ok') throw new StepFailed(`GET /health status is ${String(status)}, not ok`)
      return 'API answers'
    },

    async home() {
      const url = new URL('/', target.storefrontUrl)
      const scripts = await scriptsServed(await htmlPage(url), url)
      return `home page and ${scripts} script(s) served`
    },

    async product() {
      const listing = (await api200('GET', '/api/products?limit=100')) as {
        items?: Product[]
      } | null
      const product = (listing?.items ?? []).find((p) => (p.variants?.[0]?.stock ?? 0) >= 1)
      if (product === undefined) throw new StepFailed('no product whose first variant has stock')
      const variant = product.variants![0]!
      chosen = { product, variantId: variant.id, stockBefore: variant.stock }
      const url = new URL(`/product/${encodeURIComponent(product.slug)}`, target.storefrontUrl)
      const html = await htmlPage(url)
      if (!html.includes(product.name) && !unescapeHtml(html).includes(product.name)) {
        throw new StepFailed(`GET ${url.pathname} does not show "${product.name}"`)
      }
      const scripts = await scriptsServed(html, url)
      return `${product.slug} and ${scripts} script(s) served`
    },

    async cart() {
      await api200('POST', '/api/cart/items', { variantId: chosen!.variantId, qty: 1 })
      return `1 × ${chosen!.product.slug}`
    },

    async checkout() {
      const data = (await api200('POST', '/api/checkout', {
        email: `verify-${randomBytes(4).toString('hex')}@nymbal.dev`,
        billingAddress: ADDRESS,
        shippingAddress: ADDRESS,
      })) as { orderNumber?: unknown; orderKey?: unknown } | null
      if (typeof data?.orderNumber !== 'string' || typeof data.orderKey !== 'string') {
        throw new StepFailed('POST /api/checkout answered 200 without orderNumber and orderKey')
      }
      order = { number: data.orderNumber, key: data.orderKey }
      return `order ${order.number}`
    },

    async order() {
      const { product, variantId, stockBefore } = chosen!
      const { number, key } = order!
      const expected = stockBefore - 1
      await settle(async () => {
        const read = (await api200('GET', `/api/orders/${encodeURIComponent(number)}`, undefined, {
          'x-nymbal-order-key': key,
        })) as { status?: unknown } | null
        if (read?.status !== 'confirmed')
          return `order ${number} is ${String(read?.status)}, not confirmed`
        const doc = (await api200(
          'GET',
          `/api/products/${encodeURIComponent(product.slug)}`,
        )) as Product | null
        const stock = doc?.variants?.find((v) => v.id === variantId)?.stock
        if (stock !== expected)
          return `stock is ${String(stock)}, expected ${stockBefore} − 1 = ${expected}`
        return null
      })
      return `order ${number} confirmed, stock ${stockBefore} → ${expected}`
    },

    async admin() {
      await htmlPage(new URL('/admin/', target.apiUrl))
      const login = (await api200('POST', '/api/auth/login', {
        email: target.admin.email,
        password: target.admin.password,
      })) as { customer?: { roles?: unknown }; accessToken?: unknown } | null
      const roles = login?.customer?.roles
      if (!Array.isArray(roles) || !roles.includes('admin')) {
        throw new StepFailed(
          `signed in without the admin role (roles: ${JSON.stringify(roles ?? null)})`,
        )
      }
      if (typeof login?.accessToken !== 'string')
        throw new StepFailed('login returned no accessToken')
      const bearer = { authorization: `Bearer ${login.accessToken}` }
      const { number } = order!
      await settle(async () => {
        const listed = (await api200('GET', '/api/admin/orders', undefined, bearer)) as Array<{
          orderNumber?: unknown
        }> | null
        return Array.isArray(listed) && listed.some((o) => o.orderNumber === number)
          ? null
          : `admin orders does not list ${number}`
      })
      return `signed in, order ${number} listed`
    },
  }

  const results: StepResult[] = []
  for (const step of JOURNEY_STEPS) {
    let result: StepResult
    try {
      result = { step, ok: true, detail: await run[step]() }
    } catch (err) {
      result = { step, ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    results.push(result)
    options.onStep?.(result)
    if (!result.ok) break
  }
  return results
}
