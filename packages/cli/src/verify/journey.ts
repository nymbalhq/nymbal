import { randomBytes } from 'node:crypto'
import { createStoreClient, pageShows, StepFailed } from './store-client.js'

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

const ADDRESS = {
  firstName: 'Verify',
  lastName: 'Journey',
  addressLine1: '1 Verify Street',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
  const { api200, htmlPage, scriptsServed, request } = createStoreClient(target, {
    fetch: doFetch,
    requestTimeoutMs,
  })

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
      if (!pageShows(html, product.name)) {
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
