import { randomUUID } from 'node:crypto'
import type { APIResponse } from '@playwright/test'
import {
  adminToken,
  keyedOrderPath,
  openCheckout,
  orderKeyOf,
  orderNumberOf,
  ownProduct,
  walkToPayment,
} from '../support/checkout'
import { blockExternalRequests, expect, test } from '../support/fixtures'

// On the Astro production build (playwright.prod.config.ts, astro-prod; every test is @astro): the pages that carry a
// shopper's cart, checkout or order key are never stored by a shared cache, and the keyed order page's canonical and
// og:url name the order page alone, so the key never leaves in a page's metadata.

const cacheControlOf = (res: APIResponse): string =>
  res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'cache-control')
    .map((h) => h.value)
    .join(', ')

test.describe('AC-8: the Astro shopper pages stay out of shared caches (production build)', () => {
  // Kills: an edge that ignores the query string caching the keyed page and serving it to the next visitor; the key
  // copied into the canonical link or og:url, where crawlers and share previews keep it.
  test('AC-8: caching.astro-shopper-pages-live: /order/<n>?key=<k> of a completed checkout, /cart and /checkout answer Cache-Control with no-store, to the shopper and with no cookie; the keyed page’s canonical and og:url are /order/<n> with no key and no email @astro', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await blockExternalRequests(page)
    const buyer = `e2e-astro-live-${randomUUID().slice(0, 8)}@e2e.test`
    const product = await ownProduct(request, await adminToken(request), 5)
    await openCheckout(page, product)
    await walkToPayment(page, buyer)
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const orderNumber = orderNumberOf(page)
    const key = orderKeyOf(page)
    const keyed = keyedOrderPath(orderNumber, key)

    const cached: string[] = []
    for (const path of [keyed, '/cart', '/checkout']) {
      for (const [who, client] of [
        ['the shopper', page.request],
        ['no cookie', request],
      ] as const) {
        const cacheControl = cacheControlOf(await client.get(path))
        if (!/\bno-store\b/i.test(cacheControl))
          cached.push(`${path} (${who}): Cache-Control "${cacheControl}"`)
      }
    }
    expect(cached).toEqual([])

    await page.goto(keyed)
    await expect(page.getByTestId('order-number')).toHaveText(orderNumber, { timeout: 15_000 })
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href')
    const ogUrl = await page.locator('meta[property="og:url"]').getAttribute('content')
    for (const [label, value] of [
      ['canonical', canonical],
      ['og:url', ogUrl],
    ] as const) {
      const url = new URL(value ?? '', page.url())
      expect(
        { path: url.pathname, query: url.search, carriesKey: (value ?? '').includes(key) },
        `${label} "${value}"`,
      ).toEqual({ path: `/order/${encodeURIComponent(orderNumber)}`, query: '', carriesKey: false })
      expect(
        (value ?? '').toLowerCase().includes(buyer.toLowerCase()),
        `${label} carries the email`,
      ).toBe(false)
    }
  })
})
