import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test'
import { seedProducts } from '../../../packages/platform/src/seed/data'
import { API_URL } from './csrf'
import { blockExternalRequests, expect } from './fixtures'

// P2-18 (AC-4, AC-5): what the server-rendering journeys share. A shopper's cart comes through the product, as a
// shopper's does: a JS-on add-to-cart on the PDP, so the API's Set-Cookie lands in the context's jar; a JS-off context
// is then made from that context's storage state, so it sends the same `nymbal.cart` cookie.

export const PRODUCT = seedProducts[0]!.slug

export interface ApiCartLine {
  variantId: string
  productName: string
  variantName: string
  qty: number
  priceMinor: number
}

/** `GET /api/cart` as the API serves it: the token included, which no page may carry. */
export interface ApiCart {
  token: string
  customerId: string | null
  items: ApiCartLine[]
  subtotalMinor: number
  currency: string
}

/** The cart the context's cookie names. Call it only once the context holds the cookie (an unknown one makes a cart). */
export async function apiCart(context: BrowserContext): Promise<ApiCart> {
  const res = await context.request.get(`${API_URL}/api/cart`)
  expect(res.status(), 'GET /api/cart').toBe(200)
  return ((await res.json()) as { data: ApiCart }).data
}

/** Adds the first seeded product once from its PDP, with JS on, and returns the cart the API then holds. */
export async function addOneLine(context: BrowserContext): Promise<ApiCart> {
  const page = await context.newPage()
  await blockExternalRequests(page)
  await page.goto(`/product/${PRODUCT}`)
  const added = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/cart/items',
    { timeout: 15_000 },
  )
  await page.getByTestId('add-to-cart').click({ timeout: 15_000 })
  expect((await added).ok(), 'POST /api/cart/items').toBe(true)
  await page.close()
  const cart = await apiCart(context)
  expect(cart.items.length, 'one line in the cart').toBe(1)
  return cart
}

/** A context with JavaScript off, holding `from`'s cookies (none when `from` is undefined). */
export async function noScript(
  browser: Browser,
  testInfo: TestInfo,
  from?: BrowserContext,
): Promise<BrowserContext> {
  const baseURL = testInfo.project.use.baseURL
  return browser.newContext({
    javaScriptEnabled: false,
    ...(baseURL !== undefined && { baseURL }),
    ...(from !== undefined && { storageState: await from.storageState() }),
  })
}

/** Errors a page logs: uncaught, or console errors (the spike's DSD "not being parsed" and React's mismatch are). */
export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.name}: ${error.message}`))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (text.startsWith('Failed to load resource:') || text.includes('favicon.ico')) return
    errors.push(`console.error: ${text}`)
  })
  return errors
}

/**
 * Every Nymbal element in the document's light DOM, keyed `<tag>[<n>]` (its index among that tag's), with each part
 * name in its shadow root and the shadow roots nested inside it (prefixed by the nested hosts' tags) and how many nodes
 * carry it; null for a host with no shadow root (one the server did not render, or not yet upgraded).
 */
export type HostParts = Record<string, Record<string, number> | null>

export function hostParts(page: Page): Promise<HostParts> {
  return page.evaluate(() => {
    const count = (root: ShadowRoot, into: Record<string, number>, prefix: string): void => {
      for (const node of Array.from(root.querySelectorAll('*'))) {
        for (const part of (node.getAttribute('part') ?? '').split(/\s+/)) {
          if (part !== '') into[`${prefix}${part}`] = (into[`${prefix}${part}`] ?? 0) + 1
        }
        if (node.shadowRoot) count(node.shadowRoot, into, `${prefix}${node.localName}>`)
      }
    }
    const seen: Record<string, number> = {}
    const out: Record<string, Record<string, number> | null> = {}
    for (const host of Array.from(document.querySelectorAll('*'))) {
      if (!host.localName.startsWith('nymbal-')) continue
      const n = seen[host.localName] ?? 0
      seen[host.localName] = n + 1
      if (host.shadowRoot === null) {
        out[`${host.localName}[${n}]`] = null
        continue
      }
      const into: Record<string, number> = {}
      count(host.shadowRoot, into, '')
      out[`${host.localName}[${n}]`] = into
    }
    return out
  })
}

/** The hosts of `parts` the server rendered (those with a shadow root), with their counts. */
export function rendered(parts: HostParts): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Object.entries(parts).filter((e): e is [string, Record<string, number>] => e[1] !== null),
  )
}

/** `template[shadowrootmode]` elements left in the light DOM or any open shadow root. */
export function templatesLeft(page: Page): Promise<number> {
  return page.evaluate(() => {
    const walk = (root: Document | ShadowRoot): number =>
      root.querySelectorAll('template[shadowrootmode]').length +
      Array.from(root.querySelectorAll('*')).reduce(
        (n, el) => n + (el.shadowRoot ? walk(el.shadowRoot) : 0),
        0,
      )
    return walk(document)
  })
}

/** Waits until every tag is defined and each of its hosts has finished its pending update. */
export async function upgraded(page: Page, tags: string[]): Promise<void> {
  await expect
    .poll(
      () => page.evaluate((list) => list.every((t) => customElements.get(t) !== undefined), tags),
      {
        timeout: 15_000,
      },
    )
    .toBe(true)
  await page.evaluate(async (list) => {
    for (const tag of list) {
      for (const host of Array.from(document.querySelectorAll(tag))) {
        await (host as Element & { updateComplete?: Promise<unknown> }).updateComplete
      }
    }
  }, tags)
}

/** The tag of a `<tag>[<n>]` key. */
export const tagOf = (key: string): string => key.slice(0, key.indexOf('['))
