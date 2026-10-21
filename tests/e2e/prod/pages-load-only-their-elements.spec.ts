import type { Page } from '@playwright/test'
import { seedProducts } from '../../../packages/platform/src/seed/data'
import { blockExternalRequests, expect, test } from '../support/fixtures'

// P2-08 AC-3 (Decision 2) on production builds of both templates (playwright.prod.config.ts): on each page of
// Decision 4 the set of Nymbal elements the page defines is the set it renders, in its own markup, its layout's or an
// element's shadow root (plus `mayRender`, below: what the page renders for other data or at a later step). Kills: every page still defining every element; a page that renders an element it never
// defines. AC-5 (Decision 1): a Next product route ships no cart-page code.
//
// "Defined" is every name passed to customElements.define, recorded from before the first script runs, so a tag the
// test has never heard of still counts.

const PRODUCT = seedProducts[0]!.slug

/**
 * The five pages of Decision 4. The cart and checkout are seen with one line in the cart. `mayRender` is what the page
 * renders for some data and not for this: the product page renders a variant selector only for a product with a variant
 * choice, which the first seeded product is not, and Next's checkout renders the payment element at the payment step,
 * after the one this test sees. Defining those there is allowed and not required.
 */
const PAGES: Array<{ name: string; path: string; line: boolean; mayRender: string[] }> = [
  { name: 'home', path: '/', line: false, mayRender: [] },
  { name: 'listing', path: '/products', line: false, mayRender: [] },
  {
    name: 'product',
    path: `/product/${PRODUCT}`,
    line: false,
    mayRender: ['nymbal-variant-selector'],
  },
  { name: 'cart', path: '/cart', line: true, mayRender: [] },
  { name: 'checkout', path: '/checkout', line: true, mayRender: ['nymbal-payment-element'] },
]

/** Spec AC-3: on `/` these are undefined (`nymbal-checkout` as the spec names it, beside the payment element). */
const NOT_ON_HOME = [
  'nymbal-cart-page',
  'nymbal-checkout',
  'nymbal-payment-element',
  'nymbal-search-results',
  'nymbal-login-form',
  'nymbal-register-form',
  'nymbal-profile-form',
  'nymbal-address-form',
  'nymbal-address-book',
]

interface Elements {
  /** nymbal-* names passed to customElements.define, sorted, once each. */
  defined: string[]
  /** nymbal-* tags in the document and every open shadow root, sorted, once each. */
  rendered: string[]
}

async function recordDefinitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const names: string[] = []
    ;(window as unknown as { __nymbalDefined: string[] }).__nymbalDefined = names
    const define = customElements.define.bind(customElements)
    customElements.define = (name, constructor, options) => {
      define(name, constructor, options)
      names.push(name)
    }
  })
}

function elementsOf(page: Page): Promise<Elements> {
  return page.evaluate(() => {
    const rendered = new Set<string>()
    const walk = (root: Document | ShadowRoot): void => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.localName.startsWith('nymbal-')) rendered.add(el.localName)
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    const names = (window as unknown as { __nymbalDefined: string[] }).__nymbalDefined
    const defined = new Set(names.filter((n) => n.startsWith('nymbal-')))
    return { defined: [...defined].sort(), rendered: [...rendered].sort() }
  })
}

/** One line in the cart, added from the product page as a shopper would. */
async function addOneLine(page: Page): Promise<void> {
  await page.goto(`/product/${PRODUCT}`)
  await page.getByTestId('add-to-cart').click({ timeout: 15_000 })
  await expect(page.getByTestId('cart-checkout-btn')).toBeVisible({ timeout: 10_000 })
}

test.describe('P2-08 AC-3: pages load only their elements (production build)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page)
    await recordDefinitions(page)
  })

  for (const { name, path, line, mayRender } of PAGES) {
    test(`AC-3: ${name} (${path}) defines every Nymbal element it renders and no other`, async ({
      page,
    }) => {
      if (line) await addOneLine(page)
      // `load`, not `networkidle`: the Next cart and checkout never go idle. Elements render nested elements once their
      // data arrives, and Next defines after hydration: wait until the two sets agree, then state the relation once.
      await page.goto(path, { waitUntil: 'load' })
      await expect
        .poll(
          async () => {
            const { defined, rendered } = await elementsOf(page)
            return {
              definedNotRendered: defined.filter(
                (t) => !rendered.includes(t) && !mayRender.includes(t),
              ),
              renderedNotDefined: rendered.filter((t) => !defined.includes(t)),
            }
          },
          { timeout: 15_000 },
        )
        .toEqual({ definedNotRendered: [], renderedNotDefined: [] })
      const { defined, rendered } = await elementsOf(page)
      expect(rendered.length).toBeGreaterThan(0)
      // rendered ⊆ defined ⊆ rendered ∪ mayRender
      expect(defined.filter((t) => rendered.includes(t))).toEqual(rendered)
      expect(defined.filter((t) => !rendered.includes(t)).every((t) => mayRender.includes(t))).toBe(
        true,
      )
    })
  }

  test('AC-3: on /, the cart page, checkout, search results and account forms are not defined', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'load' })
    await expect
      .poll(() => page.evaluate(() => customElements.get('nymbal-mini-cart') !== undefined), {
        timeout: 15_000,
      })
      .toBe(true)
    const definedHere = await page.evaluate(
      (tags) => tags.filter((t) => customElements.get(t) !== undefined),
      NOT_ON_HOME,
    )
    expect(definedHere).toEqual([])
  })
})

test.describe('P2-08 AC-5: a Next product route ships no cart-page code', () => {
  // @nextjs: astro-prod leaves it out (playwright.prod.config.ts); the claim is about Next's route chunks.
  test('AC-5: the scripts the product page loads contain nymbal-add-to-cart and never nymbal-cart-page @nextjs', async ({
    page,
  }) => {
    await blockExternalRequests(page)
    const response = await page.goto(`/product/${PRODUCT}`)
    const html = await response!.text()
    // The route's own chunks, as the server lists them; chunks Next prefetches for linked routes are not this route's.
    const sources = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(
      (m) => new URL(m[1]!, page.url()).href,
    )
    const bodies = await Promise.all(
      sources.map(async (src) => (await page.request.get(src)).text()),
    )
    const carrying = (tag: string): string[] => sources.filter((_, i) => bodies[i]!.includes(tag))
    expect(carrying('nymbal-add-to-cart').length).toBeGreaterThan(0)
    expect(carrying('nymbal-cart-page')).toEqual([])
  })
})
