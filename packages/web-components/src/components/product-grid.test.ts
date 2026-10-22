import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import { cards } from '../__fixtures__/server-data.js'

// P2-17 `nymbal-product-grid` (spec Decision 1), beside its settled-store case in server-properties.test.ts.
// - AC-2: with `source="product-list"` its `load-more` part shows while the page says there is more (`has-more`, the
//   page's `nextCursor !== null`, before the store settles; the store's `pagination.hasMore` after), calls
//   `client.productList.loadMore()` once per click, and hides once the store's cursor is null. A grid without `source`
//   (home, related) never subscribes to the store: whatever the store does, it shows its attribute.
// - AC-1 (Invariants): the first four cards of any grid are `eager`, the rest are not, from the attribute and from the
//   store alike, so the listing's LCP image is never lazy.
// - The P1-11 store walk, carried over from templates/astro/tests/plp-script.test.ts (whose `renderGrid` this element
//   replaces): a product named with markup shows its name as text and adds no element.
// Kills: a load-more that calls twice or not at all, shows when the server said there is no more, or stays after the
// last page; a static grid that follows the listing's store; the first cards rendered lazy; a grid built from
// unescaped HTML.

const TAG = 'nymbal-product-grid'

type Store = {
  setState(partial: Record<string, unknown>): void
  subscribe(fn: () => void): () => void
}

function client(): { productList: Store & Record<string, unknown> } {
  return setupMockClient() as unknown as { productList: Store & Record<string, unknown> }
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

async function mount(attributes: Record<string, string>): Promise<HTMLElement> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  const el = document.createElement(TAG)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
  document.body.append(el)
  await settled(el)
  return el
}

function shadow(el: Element): ShadowRoot {
  if (el.shadowRoot === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return el.shadowRoot
}

/** The nodes carrying exactly this part token (happy-dom's `[part~=x]` also matches `x-y`). */
function parts(el: Element, part: string): Element[] {
  return [...shadow(el).querySelectorAll('[part]')].filter((n) =>
    (n.getAttribute('part') ?? '').split(/\s+/).includes(part),
  )
}

/** The `load-more` controls a shopper can see: rendered and not hidden. */
const shownLoadMore = (el: Element): Element[] =>
  parts(el, 'load-more').filter((n) => !n.hasAttribute('hidden'))

const cardsIn = (el: Element): Element[] => [...shadow(el).querySelectorAll('nymbal-product-card')]

const slugsOf = (el: Element): string[] =>
  cardsIn(el).map(
    (c) => (JSON.parse(c.getAttribute('product') ?? '{}') as { slug?: string }).slug ?? '',
  )

const settledList = (products: unknown[], cursor: string | null) => ({
  products,
  pagination: { cursor, hasMore: cursor !== null },
  loading: false,
  error: null,
})

describe('P2-17 AC-2: the grid’s load-more follows the product-list store', () => {
  it('AC-2: property: load-more shows exactly when has-more is set before the store settles, then exactly while the store has a cursor; k clicks call loadMore() k times', async () => {
    await fc.assert(
      fc.asyncProperty(
        cards('p-', 1),
        fc.boolean(),
        cards('s-', 1),
        fc.integer({ min: 1, max: 4 }),
        async (property, hasMore, stored, k) => {
          document.body.innerHTML = ''
          const c = client()
          const loadMore = vi.fn(async () => undefined)
          c.productList['loadMore'] = loadMore
          const el = await mount({
            source: 'product-list',
            products: JSON.stringify(property),
            ...(hasMore && { 'has-more': '' }),
          })
          expect(shownLoadMore(el).length, 'before the store settles: has-more').toBe(
            hasMore ? 1 : 0,
          )

          c.productList.setState(settledList(stored, 'cursor-2'))
          await settled(el)
          expect(shownLoadMore(el).length, 'the store has a next page').toBe(1)
          for (let i = 0; i < k; i += 1) {
            ;(shownLoadMore(el)[0] as HTMLElement).click()
            await settled(el)
          }
          expect(loadMore).toHaveBeenCalledTimes(k)

          c.productList.setState(settledList([...stored], null))
          await settled(el)
          expect(shownLoadMore(el).length, 'the store’s cursor is null').toBe(0)
          expect(loadMore).toHaveBeenCalledTimes(k)
        },
      ),
      { numRuns: 15 },
    )
  })

  it('AC-2: property: a grid without source never subscribes to the product-list store and keeps its attribute’s cards whatever the store does', async () => {
    await fc.assert(
      fc.asyncProperty(cards('p-'), cards('s-', 1), async (property, stored) => {
        document.body.innerHTML = ''
        const c = client()
        const subscribe = vi.spyOn(c.productList, 'subscribe')
        const el = await mount({ products: JSON.stringify(property) })
        c.productList.setState(settledList(stored, 'cursor-2'))
        await settled(el)
        expect(slugsOf(el)).toEqual(property.map((p) => p.slug))
        expect(subscribe).not.toHaveBeenCalled()
        expect(shownLoadMore(el).length, 'a static grid offers no load-more').toBe(0)
      }),
      { numRuns: 15 },
    )
  })
})

describe('P2-17 AC-1: the first four cards of a grid are eager', () => {
  it('AC-1: property: card i carries eager exactly when i < 4, from the products attribute and from the store', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          cards('p-', 1).map((c) => c[0]!),
          {
            maxLength: 9,
            selector: (c) => c.slug,
          },
        ),
        fc.uniqueArray(
          cards('s-', 1).map((c) => c[0]!),
          {
            maxLength: 9,
            selector: (c) => c.slug,
          },
        ),
        async (property, stored) => {
          document.body.innerHTML = ''
          const c = client()
          const el = await mount({ source: 'product-list', products: JSON.stringify(property) })
          const eager = (): boolean[] => cardsIn(el).map((card) => card.hasAttribute('eager'))
          expect(eager()).toEqual(property.map((_, i) => i < 4))

          c.productList.setState(settledList(stored, null))
          await settled(el)
          expect(slugsOf(el)).toEqual(stored.map((p) => p.slug))
          expect(eager()).toEqual(stored.map((_, i) => i < 4))
        },
      ),
      { numRuns: 15 },
    )
  })
})

describe('P2-17: the grid renders product names as text', () => {
  it('Store walk: after the store settles on a product named with markup, its card shows the name literally and nothing in the grid is an element the name made', async () => {
    const hostile = 'Tag "><img src=x data-p111-xss> <b data-p111-xss>bold</b>'
    const c = client()
    const el = await mount({
      source: 'product-list',
      products: JSON.stringify([
        {
          id: 'p1',
          slug: 'plain-mug',
          name: 'Plain Mug',
          priceMinor: 1200,
          currency: 'GBP',
          media: [],
        },
      ]),
    })
    const products = [
      { id: 'p2', slug: 'xss-name', name: hostile, priceMinor: 9900, currency: 'GBP', media: [] },
      {
        id: 'p1',
        slug: 'plain-mug',
        name: 'Plain Mug',
        priceMinor: 1200,
        currency: 'GBP',
        media: [],
      },
    ]
    c.productList.setState(settledList(products, null))
    await settled(el)
    for (const card of cardsIn(el)) await settled(card)

    expect(slugsOf(el)).toEqual(products.map((p) => p.slug))
    const names = cardsIn(el).map((card) =>
      (card.shadowRoot?.querySelector('[part~="name"]')?.textContent ?? '').trim(),
    )
    expect(names).toEqual(products.map((p) => p.name))
    const injected = [shadow(el), ...cardsIn(el).map((card) => card.shadowRoot!)].flatMap(
      (root) => [...root.querySelectorAll('[data-p111-xss]')],
    )
    expect(injected.length).toBe(0)
  })
})
