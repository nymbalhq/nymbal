import type { Address } from '@nymbalhq/types'
import {
  createStoreClient,
  pageShows,
  StepFailed,
  type StoreClientOptions,
} from '../verify/store-client.js'
import { timed, type HeartbeatResult, type StoreStep } from './result.js'

// The store check: a shopper's checkout over HTTP with the store's heartbeat address, which the store places as a
// synthetic order, cancels at once and refuses `checkout.synthetic` naming. It quotes first and checks out at the quoted
// total and option, as a shopper's page does, so the store's total check runs for it too.

export interface StoreCheckTarget {
  apiUrl: string
  /** Absent: the storefront pages are not checked. */
  storefrontUrl?: string
  /** The store's heartbeat address, exactly as configured. */
  email: string
  /** The variant to take one unit of; absent, the first product whose first variant has stock. */
  sku?: string
  /** Billing and shipping. */
  address: Address
}

interface Product {
  id: string
  slug: string
  name: string
  variants?: Array<{ id: string; sku?: string; stock: number }>
}

/** A checkout the store answered with a real order: its address is not the store's heartbeat address. */
class Unrecognised extends Error {
  constructor(readonly orderNumber: string) {
    super(
      `the store placed order ${orderNumber}: it does not take this heartbeat address for its own (the store's features.heartbeat or heartbeat.store.email differ, or it was not restarted)`,
    )
  }
}

/** Runs the steps in order and stops at the first that fails; never throws. */
export async function runStoreCheck(
  target: StoreCheckTarget,
  options: StoreClientOptions = {},
): Promise<HeartbeatResult> {
  const finish = timed('store')
  const { request, api, api200, htmlPage, scriptsServed } = createStoreClient(target, options)
  const { storefrontUrl } = target

  let chosen: { product: Product; variantId: string } | null = null
  let quoted: { totalMinor: number; shippingOptionId: string } | null = null
  // Set inside a step: without the assertion TypeScript reads it as null after the loop.
  let order = null as { number: string; key: string } | null

  /** The configured sku's variant, or the first product whose first variant has stock, over every page. */
  async function pick(): Promise<{ product: Product; variantId: string }> {
    let cursor: string | null = null
    do {
      const page = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      const listing = (await api200('GET', `/api/products?limit=100${page}`)) as {
        items?: Product[]
        nextCursor?: string | null
      } | null
      for (const product of listing?.items ?? []) {
        const first = product.variants?.[0]
        const variant =
          target.sku === undefined
            ? (first?.stock ?? 0) >= 1
              ? first
              : undefined
            : product.variants?.find((v) => v.sku === target.sku)
        if (variant !== undefined) return { product, variantId: variant.id }
      }
      cursor = listing?.nextCursor ?? null
    } while (cursor !== null)
    throw new StepFailed(
      target.sku === undefined
        ? 'no product whose first variant has stock'
        : `no variant has sku ${target.sku}`,
    )
  }

  const steps: Array<[StoreStep, () => Promise<void>]> = [
    [
      'health',
      async () => {
        const data = await request(new URL('/health', target.apiUrl))
        if (data.status !== 200) throw new StepFailed(`GET /health answered ${data.status}`)
        let status: unknown
        try {
          status = (JSON.parse(data.text) as { status?: unknown }).status
        } catch {
          status = undefined
        }
        if (status !== 'ok') {
          throw new StepFailed(`GET /health status is ${String(status)}, not ok`)
        }
      },
    ],
    [
      'home',
      async () => {
        if (storefrontUrl === undefined) return
        const url = new URL('/', storefrontUrl)
        await scriptsServed(await htmlPage(url), url)
      },
    ],
    [
      'product',
      async () => {
        chosen = await pick()
        if (storefrontUrl === undefined) return
        const { product } = chosen
        const url = new URL(`/product/${encodeURIComponent(product.slug)}`, storefrontUrl)
        const html = await htmlPage(url)
        if (!pageShows(html, product.name)) {
          throw new StepFailed(`GET ${url.pathname} does not show "${product.name}"`)
        }
        await scriptsServed(html, url)
      },
    ],
    [
      'cart',
      async () => {
        await api200('POST', '/api/cart/items', { variantId: chosen!.variantId, qty: 1 })
      },
    ],
    [
      'quote',
      async () => {
        const data = (await api200('POST', '/api/checkout/quote', {
          shippingAddress: target.address,
          email: target.email,
        })) as { shippingOptionId?: unknown; totals?: { totalMinor?: unknown } } | null
        const totalMinor = data?.totals?.totalMinor
        const shippingOptionId = data?.shippingOptionId
        if (typeof totalMinor !== 'number' || typeof shippingOptionId !== 'string') {
          throw new StepFailed('POST /api/checkout/quote answered no total or shipping option')
        }
        quoted = { totalMinor, shippingOptionId }
      },
    ],
    [
      'checkout',
      async () => {
        const answer = await api('POST', '/api/checkout', {
          email: target.email,
          billingAddress: target.address,
          shippingAddress: target.address,
          expectedTotalMinor: quoted!.totalMinor,
          shippingOptionId: quoted!.shippingOptionId,
        })
        if (answer.status === 200) {
          const placed = (answer.data as { orderNumber?: unknown } | null)?.orderNumber
          throw new Unrecognised(String(placed))
        }
        const code = answer.error?.code
        const context = answer.error?.context ?? {}
        const { orderNumber, orderKey } = context
        if (
          answer.status === 409 &&
          code === 'checkout.synthetic' &&
          typeof orderNumber === 'string' &&
          typeof orderKey === 'string'
        ) {
          order = { number: orderNumber, key: orderKey }
          return
        }
        const message = typeof answer.error?.message === 'string' ? `: ${answer.error.message}` : ''
        throw new StepFailed(
          `POST /api/checkout answered ${answer.status} ${String(code ?? 'with no error code')}${message}`,
        )
      },
    ],
    [
      'order',
      async () => {
        const { number, key } = order!
        const read = (await api200('GET', `/api/orders/${encodeURIComponent(number)}`, undefined, {
          'x-nymbal-order-key': key,
        })) as { status?: unknown } | null
        if (read?.status !== 'cancelled') {
          throw new StepFailed(`order ${number} is ${String(read?.status)}, not cancelled`)
        }
      },
    ],
  ]

  for (const [step, run] of steps) {
    try {
      await run()
    } catch (err) {
      if (err instanceof Unrecognised) {
        return finish('unrecognised', err.message, { step, orderNumber: err.orderNumber })
      }
      return finish('failed', err instanceof Error ? err.message : String(err), { step })
    }
  }
  const { number } = order!
  return finish('ok', `order ${number} placed and cancelled`, { orderNumber: number })
}
