import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import { renderElement } from '../ssr/index.js'

// The product page says what its JSON-LD tells search engines: above the reviews, the product's stars, its average to
// one decimal and how many reviews it has. A product with no rating gets no summary, and the list or its empty state
// as before.

const TAG = 'nymbal-review-list'

beforeEach(() => {
  setupMockClient()
})

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

async function bothRenders(
  attributes: Record<string, string>,
): Promise<Array<[string, ParentNode | null]>> {
  return [
    ['server', serverRoot(attributes)],
    ['client', await clientRoot(attributes)],
  ]
}

const FILLED = '★'
const EMPTY = '☆'
const count = (text: string, glyph: string): number => [...text].filter((c) => c === glyph).length

/** The summary as a shopper reads it: its filled and empty stars, and its words with the stars taken out. */
function summaryOf(root: ParentNode | null) {
  const parts = [...(root?.querySelectorAll('[part~="summary"]') ?? [])]
  if (parts.length !== 1) return { parts: parts.length }
  const text = parts[0]!.textContent ?? ''
  const first = [...(root?.children ?? [])].find((c) => c.localName !== 'style')
  return {
    parts: 1,
    first: first?.getAttribute('part')?.split(/\s+/).includes('summary') ?? false,
    filled: count(text, FILLED),
    empty: count(text, EMPTY),
    words: text.replaceAll(FILLED, '').replaceAll(EMPTY, '').replace(/\s+/g, ' ').trim(),
  }
}

const review = (id: string, rating: number) => ({
  id,
  productId: 'p1',
  rating,
  title: `Title ${id}`,
  body: `Body ${id}`,
  submittedAt: '2026-10-22T00:00:00.000Z',
})

const TWO_REVIEWS = JSON.stringify([review('r1', 5), review('r2', 4)])

describe('nymbal-review-list summary', () => {
  // Kills: the rating in the page's JSON-LD but not on the page; "1 reviews"; the summary below the list.
  it('AC-5: with rating { average: 4.5, count: 2 } the list renders part summary first, with 5 filled stars of five and the text "4.5 out of 5 · 2 reviews", above the same two reviews, in the server render and the client render alike', async () => {
    const attributes = { reviews: TWO_REVIEWS, rating: JSON.stringify({ average: 4.5, count: 2 }) }
    for (const [where, root] of await bothRenders(attributes)) {
      expect(
        { ...summaryOf(root), reviews: root?.querySelectorAll('[part~="review"]').length },
        `${where} render`,
      ).toEqual({
        parts: 1,
        first: true,
        filled: 5,
        empty: 0,
        words: '4.5 out of 5 · 2 reviews',
        reviews: 2,
      })
    }
  })

  it('AC-5: property: over generated ratings, the summary shows Math.round(average) filled stars of five and "<average.toFixed(1)> out of 5 · <count> review(s)", "1 review" for one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10, max: 50 }).map((tenths) => tenths / 10),
        fc.integer({ min: 1, max: 100_000 }),
        async (average, n) => {
          const attributes = { reviews: TWO_REVIEWS, rating: JSON.stringify({ average, count: n }) }
          const filled = Math.round(average)
          for (const [where, root] of await bothRenders(attributes)) {
            expect(summaryOf(root), `${where} render of ${average} from ${n}`).toEqual({
              parts: 1,
              first: true,
              filled,
              empty: 5 - filled,
              words: `${average.toFixed(1)} out of 5 · ${n} ${n === 1 ? 'review' : 'reviews'}`,
            })
          }
        },
      ),
      { numRuns: 30, examples: [[4, 1]] },
    )
  })

  // Kills: a summary of zero shown for a product with no rating, or the reviews or the empty state lost beside it.
  it('AC-5: property: with rating null, absent or count 0 there is no summary part, and the reviews or the empty state render as without a rating', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Record<string, string>>(
          {},
          { rating: 'null' },
          { rating: JSON.stringify({ average: 0, count: 0 }) },
        ),
        fc.constantFrom('[]', TWO_REVIEWS),
        async (rated, reviews) => {
          const withRating = await bothRenders({ reviews, ...rated })
          const without = await bothRenders({ reviews })
          for (const [i, [where, root]] of withRating.entries()) {
            const plain = without[i]![1]
            expect(
              {
                summary: root?.querySelectorAll('[part~="summary"]').length,
                reviews: root?.querySelectorAll('[part~="review"]').length,
                empty: root?.querySelectorAll('[part~="empty"]').length,
              },
              `${where} render of ${JSON.stringify(rated)} with ${reviews}`,
            ).toEqual({
              summary: 0,
              reviews: plain?.querySelectorAll('[part~="review"]').length,
              empty: plain?.querySelectorAll('[part~="empty"]').length,
            })
          }
        },
      ),
      { numRuns: 12 },
    )
  })
})
