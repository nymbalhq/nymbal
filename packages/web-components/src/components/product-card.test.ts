import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import { renderElement } from '../ssr/index.js'
import { formatMoney } from '../__fixtures__/server-data.js'

// `nymbal-product-card` shows the product's own image, and a placeholder seeded by its slug when it has none, as both
// templates' search cards did, so a product without media still renders a square image, not an empty box.
// Kills: a card with no media rendering no image, a placeholder that ignores the slug, a placeholder over real media.

const TAG = 'nymbal-product-card'

beforeEach(() => {
  setupMockClient()
})

async function imageSrc(product: Record<string, unknown>): Promise<string | null | undefined> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  document.body.innerHTML = ''
  const el = document.createElement(TAG)
  el.setAttribute('product', JSON.stringify(product))
  document.body.appendChild(el)
  await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete
  return el.shadowRoot?.querySelector('[part~="image"]')?.getAttribute('src')
}

const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/)
const name = fc.stringMatching(/^[A-Z][a-z]{1,10}$/)
const url = fc.stringMatching(/^[a-z]{1,8}$/).map((p) => `https://cdn.example.test/${p}.jpg`)

describe('nymbal-product-card image', () => {
  it('property: a product with no media and no imageUrl shows https://picsum.photos/seed/<slug>/600/600', async () => {
    await fc.assert(
      fc.asyncProperty(
        slug,
        name,
        fc.constantFrom({}, { media: [] }, { media: [{}] }),
        async (s, n, rest) => {
          expect(await imageSrc({ slug: s, name: n, priceMinor: 1000, ...rest })).toBe(
            `https://picsum.photos/seed/${encodeURIComponent(s)}/600/600`,
          )
        },
      ),
      { numRuns: 30 },
    )
  })

  it('property: a product with media or an imageUrl shows that image, not the placeholder', async () => {
    await fc.assert(
      fc.asyncProperty(slug, name, url, fc.boolean(), async (s, n, u, viaMedia) => {
        const own = viaMedia ? { media: [{ url: u, alt: n }] } : { imageUrl: u, media: [] }
        expect(await imageSrc({ slug: s, name: n, priceMinor: 1000, ...own })).toBe(u)
      }),
      { numRuns: 30 },
    )
  })
})

// AC-1: the card's `eager` renders its image `loading="eager" fetchpriority="high"` (the grid's first four cards), and
// without it the image stays lazy, on the server as in the browser, since the server's image is the one the LCP
// measures. A card whose product has a `priceRange` shows exactly one amount, the from-price `priceRange.minMinor`,
// whatever `priceMinor` is (`buildProductDoc` sets it to the first variant's), else `priceMinor`.

/** The card's shadow root as the server renders it, parsed inert. */
function serverRoot(attributes: Record<string, string>): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = renderElement(TAG, { attributes })
  const host = template.content.firstElementChild
  const shadow = [...(host?.children ?? [])].find((c) => c.localName === 'template')
  return (shadow as HTMLTemplateElement | undefined)?.content ?? document.createDocumentFragment()
}

async function clientRoot(attributes: Record<string, string>): Promise<ShadowRoot | null> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  document.body.innerHTML = ''
  const el = document.createElement(TAG)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
  document.body.appendChild(el)
  await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete
  return el.shadowRoot
}

const money = fc.integer({ min: 0, max: 100_000 })
const range = fc
  .tuple(money, money)
  .map(([a, b]) => ({ minMinor: Math.min(a, b), maxMinor: Math.max(a, b) }))

describe('AC-1: nymbal-product-card eager and from-price', () => {
  it('AC-1: property: with eager the image is loading="eager" fetchpriority="high", without it loading="lazy" and not high priority, in the server render and the client render alike', async () => {
    await fc.assert(
      fc.asyncProperty(slug, name, fc.boolean(), async (s, n, eager) => {
        const attributes = {
          product: JSON.stringify({ slug: s, name: n, priceMinor: 1000, media: [] }),
          ...(eager && { eager: '' }),
        }
        const want = { loading: eager ? 'eager' : 'lazy', high: eager }
        for (const [where, root] of [
          ['server', serverRoot(attributes)],
          ['client', await clientRoot(attributes)],
        ] as const) {
          const img = root?.querySelector('[part~="image"]')
          expect(
            {
              loading: img?.getAttribute('loading'),
              high: img?.getAttribute('fetchpriority') === 'high',
            },
            `${where} render, eager=${eager}`,
          ).toEqual(want)
        }
      }),
      { numRuns: 20 },
    )
  })

  it('AC-1: property: the price part shows exactly one amount, formatMoney(priceRange.minMinor) when the product has a range, else formatMoney(priceMinor)', async () => {
    await fc.assert(
      fc.asyncProperty(
        slug,
        name,
        fc.option(money),
        fc.option(range),
        async (s, n, priceMinor, priceRange) => {
          const product = { slug: s, name: n, priceMinor, priceRange, currency: 'GBP', media: [] }
          const expected =
            priceRange !== null
              ? [formatMoney(priceRange.minMinor)]
              : priceMinor !== null
                ? [formatMoney(priceMinor)]
                : []
          const root = await clientRoot({ product: JSON.stringify(product) })
          const shown = [...(root?.querySelectorAll('[part~="price"]') ?? [])].map((p) =>
            (p.textContent ?? '').trim(),
          )
          expect(shown).toEqual(expected)
        },
      ),
      { numRuns: 40 },
    )
  })
})
