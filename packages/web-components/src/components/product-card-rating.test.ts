import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProductRating } from '@nymbalhq/types'
import { setupMockClient } from '../testing/index.js'
import { renderElement } from '../ssr/index.js'
import { cardProductOf } from './product-card.js'

// A product card shows the product's rating where the shopper compares products: stars, the average to one decimal
// and the number of reviews, with a label a screen reader reads whole; a product without a rating shows nothing.

const TAG = 'nymbal-product-card'

beforeEach(() => {
  setupMockClient()
})

/** The card's shadow root as the server renders it, parsed inert. */
function serverRoot(product: unknown): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = renderElement(TAG, { attributes: { product: JSON.stringify(product) } })
  const host = template.content.firstElementChild
  const shadow = [...(host?.children ?? [])].find((c) => c.localName === 'template')
  return (shadow as HTMLTemplateElement | undefined)?.content ?? document.createDocumentFragment()
}

async function clientRoot(product: unknown): Promise<ShadowRoot | null> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  document.body.innerHTML = ''
  const el = document.createElement(TAG)
  el.setAttribute('product', JSON.stringify(product))
  document.body.appendChild(el)
  await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete
  return el.shadowRoot
}

async function bothRenders(product: unknown): Promise<Array<[string, ParentNode | null]>> {
  return [
    ['server', serverRoot(product)],
    ['client', await clientRoot(product)],
  ]
}

const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/)
const name = fc.stringMatching(/^[A-Z][a-z]{1,10}$/)
/** A served rating: one decimal in [1, 5], at least one review. */
const rating = fc.record({
  average: fc.integer({ min: 10, max: 50 }).map((tenths) => tenths / 10),
  count: fc.integer({ min: 1, max: 100_000 }),
})

const FILLED = '★'
const EMPTY = '☆'
const count = (text: string, glyph: string): number => [...text].filter((c) => c === glyph).length

/** The text of a node less its aria-hidden descendants, whitespace collapsed. */
function spokenText(node: Element): string {
  const copy = node.cloneNode(true) as Element
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function hiddenText(node: Element): string {
  return [...node.querySelectorAll('[aria-hidden="true"]')].map((n) => n.textContent ?? '').join('')
}

describe('nymbal-product-card rating', () => {
  // Kills: the card ignoring the rating, a label or text that drops the decimal or the count, "1 reviews", stars that
  // round another way, stars read aloud, a rating outside the card's body or before its price.
  it('AC-4: property: over generated ratings, the card renders part rating with aria-label "Rated <average.toFixed(1)> out of 5 from <count> review(s)", the text "<average.toFixed(1)> (<count>)" and Math.round(average) filled stars of five, hidden from screen readers, after the price in the body, in the server render and the client render alike', async () => {
    await fc.assert(
      fc.asyncProperty(slug, name, rating, async (s, n, r) => {
        const product = {
          slug: s,
          name: n,
          priceMinor: 1000,
          currency: 'GBP',
          media: [],
          rating: r,
        }
        const shown = r.average.toFixed(1)
        const label = `Rated ${shown} out of 5 from ${r.count} ${r.count === 1 ? 'review' : 'reviews'}`
        const filled = Math.round(r.average)
        for (const [where, root] of await bothRenders(product)) {
          const parts = [...(root?.querySelectorAll('[part~="rating"]') ?? [])]
          expect(parts.length, `${where}: rating parts for ${JSON.stringify(r)}`).toBe(1)
          const part = parts[0]!
          expect(
            {
              role: part.getAttribute('role'),
              label: part.getAttribute('aria-label'),
              spoken: spokenText(part),
              filled: count(hiddenText(part), FILLED),
              empty: count(hiddenText(part), EMPTY),
              starsAnywhere:
                count(part.textContent ?? '', FILLED) + count(part.textContent ?? '', EMPTY),
              inBody: part.closest('[part~="body"]') !== null,
              afterPrice:
                (root?.querySelector('[part~="price"]')?.compareDocumentPosition(part) ?? 0) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            },
            `${where} render of ${JSON.stringify(r)}`,
          ).toEqual({
            role: 'img',
            label,
            spoken: `${shown} (${r.count})`,
            filled,
            empty: 5 - filled,
            starsAnywhere: 5,
            inBody: true,
            afterPrice: Node.DOCUMENT_POSITION_FOLLOWING,
          })
        }
      }),
      {
        numRuns: 40,
        examples: [
          ['mug', 'Mug', { average: 4.5, count: 2 }],
          ['cup', 'Cup', { average: 1, count: 1 }],
        ],
      },
    )
  })

  // Kills: a zero, an empty row of stars or "0 reviews" shown for a product with no rating.
  it('AC-4: property: with rating null, absent or count 0, neither render has a rating part, while the name and price still show', async () => {
    await fc.assert(
      fc.asyncProperty(
        slug,
        name,
        fc.constantFrom<Record<string, unknown>>(
          {},
          { rating: null },
          { rating: { average: 0, count: 0 } },
          { rating: { average: 4.5, count: 0 } },
        ),
        async (s, n, rated) => {
          const product = {
            slug: s,
            name: n,
            priceMinor: 1000,
            currency: 'GBP',
            media: [],
            ...rated,
          }
          for (const [where, root] of await bothRenders(product)) {
            expect(
              {
                rating: root?.querySelectorAll('[part~="rating"]').length,
                name: root?.querySelector('[part~="name"]')?.textContent?.trim(),
                stars:
                  count(root?.textContent ?? '', FILLED) + count(root?.textContent ?? '', EMPTY),
              },
              `${where} render of ${JSON.stringify(rated)}`,
            ).toEqual({ rating: 0, name: n, stars: 0 })
          }
        },
      ),
      { numRuns: 20 },
    )
  })
})

describe('cardProductOf rating', () => {
  const listed = fc.record({
    id: fc.uuid(),
    slug,
    name,
    description: fc.string(),
    priceMinor: fc.option(fc.integer({ min: 0, max: 100_000 })),
    priceRange: fc.constant(null),
    currency: fc.constant('GBP'),
    variants: fc.constant([]),
    media: fc.constant([]),
  })

  // Kills: cardProductOf dropping the rating, so every grid that maps its products to cards shows none.
  it('AC-4: property: cardProductOf of a product with a rating keeps that rating; of one with rating null or none answers rating null', () => {
    fc.assert(
      fc.property(
        listed,
        fc.option(rating, { nil: undefined }),
        fc.boolean(),
        (p, r, explicitNull) => {
          const product: Record<string, unknown> = { ...p }
          if (r !== undefined) product.rating = r
          else if (explicitNull) product.rating = null
          const card = cardProductOf(product as Parameters<typeof cardProductOf>[0]) as {
            rating?: ProductRating | null
          }
          expect('rating' in card ? card.rating : 'missing').toEqual(r ?? null)
        },
      ),
      { numRuns: 60 },
    )
  })
})
