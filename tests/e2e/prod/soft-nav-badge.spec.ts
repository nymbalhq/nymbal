import type { Locator, Page } from '@playwright/test'
import { markWindow, windowMarked } from '../support/elements'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { addOneLine, apiCart, upgraded } from '../support/server-rendered'

// On the Next production build: the shopper pages' header carries the cart's count, the catalog pages' header carries
// none and fills it from the cart store. A soft navigation from a shopper page to a catalog page mounts the catalog
// header's mini-cart after the cart store has loaded, so the store sends it no update; its badge must still equal the
// cart.

interface Hop {
  from: string
  to: string
  anchor: (page: Page) => Locator
}

const logo = (page: Page): Locator => page.locator('nymbal-site-header [part~="logo"]')
const productsLink = (page: Page): Locator =>
  page
    .locator('nymbal-site-header [part~="link"][href="/products"]')
    .filter({ visible: true })
    .first()

const HOPS: Hop[] = [
  { from: '/cart', to: '/', anchor: logo },
  { from: '/checkout', to: '/', anchor: logo },
  { from: '/account/login', to: '/products', anchor: productsLink },
]

test.describe('the header badge after a soft navigation from a shopper page to a catalog page (production build)', () => {
  for (const { from, to, anchor } of HOPS) {
    test(`cart.badge-sum: after a soft navigation from ${from} to ${to}, the header's mini-cart badge equals the sum of GET /api/cart's quantities @nextjs`, async ({
      page,
      context,
    }) => {
      await blockExternalRequests(page)
      await addOneLine(context)
      const count = (await apiCart(context)).items.reduce((n, line) => n + line.qty, 0)
      expect(count, 'the cart’s quantity sum').toBeGreaterThan(0)

      await page.goto(from, { waitUntil: 'load' })
      await upgraded(page, ['nymbal-site-header', 'nymbal-mini-cart'])
      const badge = page
        .locator('nymbal-site-header nymbal-mini-cart')
        .getByTestId('mini-cart-badge')
      await expect(badge, `${from}: the badge before the navigation`).toHaveText(String(count))
      await markWindow(page)

      await anchor(page).click()
      await page.waitForURL((url) => url.pathname === to)
      expect(await windowMarked(page), `${from} → ${to} was a soft navigation`).toBe(true)
      await expect(badge, `${to}: the badge after the navigation`).toHaveText(String(count), {
        timeout: 10_000,
      })
    })
  }
})
