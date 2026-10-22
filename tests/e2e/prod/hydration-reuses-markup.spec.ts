import type { Page } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import {
  addOneLine,
  hostParts,
  noScript,
  rendered,
  tagOf,
  templatesLeft,
  upgraded,
  watchErrors,
} from '../support/server-rendered'
import { optionProduct } from '../support/variants'

// P2-18 AC-5, on production builds of both templates: with JavaScript on, each element the server rendered takes
// over the markup it was given. On every page of AC-4 the part counts inside each server-rendered element's shadow
// root (nested shadow roots included, per part name: `summary-row` repeats by design) equal those the same page shows
// with JavaScript off, no `template[shadowrootmode]` is left in the light DOM or a shadow root, and the console logs
// no error (the DSD "not being parsed" and React hydration-mismatch messages the spike saw included). With
// `GET /api/cart` held, `/cart` and `/checkout` still show the line once their elements are defined: the property the
// server rendered from stands until the store settles. On Next, a soft navigation `/` → `/cart` → `/` → `/cart` →
// `/checkout` holds the same, a revisit of an already-defined element included, and logs no NotSupportedError.
// Kills: a DSD template left unparsed and a second shadow root rendered; the hydrate support evaluating after lit (the
// client render appends to the server's nodes); a revisit attaching a shadow root twice; React logging a mismatch.

interface Visit {
  name: string
  path: (slug: string) => string
  /** Needs a line in the cart. */
  line: boolean
  /** The element this page exists to render: the server must have rendered it, so the comparison is not vacuous. */
  element: string
}

const VISITS: Visit[] = [
  { name: 'home', path: () => '/', line: true, element: 'nymbal-mini-cart' },
  { name: 'cart', path: () => '/cart', line: true, element: 'nymbal-cart-page' },
  { name: 'checkout', path: () => '/checkout', line: true, element: 'nymbal-checkout' },
  { name: 'search', path: () => '/search?q=wool', line: false, element: 'nymbal-search-results' },
  {
    name: 'product',
    path: (slug) => `/product/${slug}`,
    line: false,
    element: 'nymbal-variant-selector',
  },
  { name: 'login', path: () => '/account/login', line: false, element: 'nymbal-login-form' },
  {
    name: 'register',
    path: () => '/account/register',
    line: false,
    element: 'nymbal-register-form',
  },
]

/** The server-rendered hosts of `path` with JavaScript off, in a context holding `page`'s cookies. */
async function withScriptOff(
  page: Page,
  path: string,
  browser: Parameters<typeof noScript>[0],
  testInfo: Parameters<typeof noScript>[1],
): Promise<Record<string, Record<string, number>>> {
  const off = await noScript(browser, testInfo, page.context())
  const offPage = await off.newPage()
  await blockExternalRequests(offPage)
  await offPage.goto(path)
  const hosts = rendered(await hostParts(offPage))
  await off.close()
  return hosts
}

/** The hosts' counts on the JS-on page, for exactly the hosts the JS-off page rendered. */
async function sameHosts(
  page: Page,
  keys: string[],
): Promise<Record<string, Record<string, number> | null>> {
  const all = await hostParts(page)
  return Object.fromEntries(keys.map((k) => [k, all[k] ?? null]))
}

const tagsOf = (keys: string[]): string[] => [...new Set(keys.map(tagOf))]

test.describe('P2-18 AC-5: hydration reuses the server markup', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page)
  })

  for (const visit of VISITS) {
    test(`AC-5: ${visit.name}: with JS on every server-rendered element keeps the part counts it has with JS off, no shadowrootmode template is left, and the console has no error`, async ({
      page,
      browser,
      request,
    }, testInfo) => {
      const slug =
        visit.name === 'product'
          ? (
              await optionProduct(request, await adminToken(request), [
                { options: [{ name: 'Size', value: 'S' }], priceMinor: 1500, stock: 3 },
                { options: [{ name: 'Size', value: 'M' }], priceMinor: 1600, stock: 3 },
              ])
            ).slug
          : ''
      if (visit.line) await addOneLine(page.context())
      const path = visit.path(slug)

      const off = await withScriptOff(page, path, browser, testInfo)
      const keys = Object.keys(off)
      expect(keys.map(tagOf), `${visit.element} rendered by the server`).toContain(visit.element)
      expect(Math.min(...Object.values(off).map((c) => Object.keys(c).length))).toBeGreaterThan(0)

      const errors = watchErrors(page)
      await page.goto(path, { waitUntil: 'load' })
      await upgraded(page, tagsOf(keys))
      await expect.poll(() => sameHosts(page, keys), { timeout: 10_000 }).toEqual(off)
      expect(await templatesLeft(page)).toBe(0)
      expect(errors).toEqual([])
    })
  }

  for (const [path, tag] of [
    ['/cart', 'nymbal-cart-page'],
    ['/checkout', 'nymbal-checkout'],
  ] as const) {
    test(`AC-5: with GET /api/cart held, ${path} shows the cart line once ${tag} is defined`, async ({
      page,
    }) => {
      const cart = await addOneLine(page.context())
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route('**/api/cart', async (route) => {
        await held
        await route.continue().catch(() => undefined)
      })

      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await upgraded(page, [tag])
      await expect(page.locator(tag).locator('[part~="item-name"]')).toHaveText(
        cart.items.map((l) => l.productName),
      )
      release()
    })
  }

  test('AC-5: on Next, soft navigation / → /cart → / → /cart → /checkout keeps every server-rendered element’s part counts, leaves no template, and logs no error or NotSupportedError @nextjs', async ({
    page,
    browser,
  }, testInfo) => {
    const cart = await addOneLine(page.context())
    const route = ['/cart', '/', '/cart', '/checkout']
    const expected: Record<string, Record<string, Record<string, number>>> = {}
    // The element each page exists to render: the server must have rendered it, so the comparison is not vacuous.
    const element: Record<string, string> = {
      '/': 'nymbal-mini-cart',
      '/cart': 'nymbal-cart-page',
      '/checkout': 'nymbal-checkout',
    }
    for (const path of new Set(['/', ...route])) {
      expected[path] = await withScriptOff(page, path, browser, testInfo)
      expect(
        Object.keys(expected[path]!).map(tagOf),
        `${element[path]} rendered by the server on ${path}`,
      ).toContain(element[path])
    }

    const errors = watchErrors(page)
    await page.goto('/', { waitUntil: 'load' })
    await upgraded(page, tagsOf(Object.keys(expected['/']!)))
    await page.evaluate(() => {
      ;(window as unknown as { __softNavigation: boolean }).__softNavigation = true
    })

    for (const path of route) {
      if (path === '/') {
        // The header logo is a next/link <Link>.
        await page.locator('header a[href="/"]').first().click()
      } else {
        // No <Link> in the templates points at /cart or /checkout; the App Router's push is the navigation a <Link>
        // makes (the RSC payload inserted with innerHTML).
        await page.evaluate((to) => {
          ;(
            window as unknown as { next: { router: { push(href: string): void } } }
          ).next.router.push(to)
        }, path)
      }
      await page.waitForURL((url) => url.pathname === path)
      const soft = await page.evaluate(
        () => (window as unknown as { __softNavigation?: boolean }).__softNavigation === true,
      )
      expect(soft, `${path} reached without a full load`).toBe(true)

      const keys = Object.keys(expected[path]!)
      await upgraded(page, tagsOf(keys))
      await expect
        .poll(() => sameHosts(page, keys), { timeout: 10_000, message: `part counts on ${path}` })
        .toEqual(expected[path])
      expect(await templatesLeft(page), `templates left on ${path}`).toBe(0)
      if (path === '/cart' || path === '/checkout') {
        const tag = path === '/cart' ? 'nymbal-cart-page' : 'nymbal-checkout'
        await expect(page.locator(tag).locator('[part~="item-name"]')).toHaveText(
          cart.items.map((l) => l.productName),
        )
      }
    }
    expect(errors.filter((e) => e.includes('NotSupportedError'))).toEqual([])
    expect(errors).toEqual([])
  })
})
