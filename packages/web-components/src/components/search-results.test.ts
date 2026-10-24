import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NymbalClient } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// AC-3: `nymbal-search-results` is the search page's results region on both templates, and it agrees with the search
// store: one `nymbal-product-card` per result in store order, each a link `product-card-<slug>` to
// `/product/<encodeURIComponent(slug)>` with its name as text; the loading, no-term and no-results states, by the
// headings the search journeys find them by; load-more iff `nextCursor !== null`, one click one `loadMore()`.

const TAG = 'nymbal-search-results'
const NO_TERM = 'Search our store'
const NO_RESULTS = 'No results found'

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
})

function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return root
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

function setSearch(state: Record<string, unknown>): void {
  ;(client.search as unknown as { setState(p: object): void }).setState(state)
}

async function mount(): Promise<HTMLElement> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  expect(
    customElements.get('nymbal-product-card'),
    'nymbal-product-card is defined by registerComponents()',
  ).toBeDefined()
  const el = document.createElement(TAG)
  document.body.appendChild(el)
  await settled(el)
  return el
}

function cards(root: ShadowRoot): Element[] {
  return [...root.querySelectorAll('nymbal-product-card')]
}

function headings(root: ShadowRoot): string[] {
  return [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(
    (h) => h.textContent?.trim() ?? '',
  )
}

const MARKUP = ['<b data-injected>Wool</b>', '<img src="x" data-injected onerror="alert(1)">']

// Slugs a store may hold, including the characters a path segment must encode.
const slug = fc.stringMatching(/^[a-z0-9][a-z0-9é ?#&%/-]{0,10}$/)

const result = fc.record({
  id: fc.stringMatching(/^p[a-z0-9]{1,8}$/),
  slug,
  name: fc.oneof(fc.stringMatching(/^[A-Z][a-z]{1,10}$/), fc.constantFrom(...MARKUP)),
  priceMinor: fc.option(fc.integer({ min: 0, max: 100_000 })),
  priceRange: fc.constant(null),
  currency: fc.constant('GBP'),
  media: fc.constant([]),
})

const results = (min: number, max: number) =>
  fc.uniqueArray(result, { minLength: min, maxLength: max, selector: (r) => r.slug })

const term = fc.stringMatching(/^[a-z]{2,8}$/)

describe('nymbal-search-results agrees with the search store', () => {
  it('AC-3: property: exactly results.length nymbal-product-cards in store order, each linking product-card-<slug> to /product/<encodeURIComponent(slug)> with its name as text', async () => {
    await fc.assert(
      fc.asyncProperty(term, results(1, 6), async (query, items) => {
        document.body.innerHTML = ''
        client = setupMockClient()
        setSearch({ query, results: items, total: items.length, nextCursor: null, loading: false })
        const root = shadow(await mount())

        const shown = cards(root)
        expect(shown).toHaveLength(items.length)
        for (const [i, item] of items.entries()) {
          const card = shown[i]!
          await settled(card)
          const cardRoot = shadow(card)
          const link = cardRoot.querySelector('a[data-testid^="product-card-"]')
          expect(link, `card ${i} renders its link`).not.toBeNull()
          expect(link!.getAttribute('data-testid'), `card ${i}: test id`).toBe(
            `product-card-${item.slug}`,
          )
          expect(link!.getAttribute('href'), `card ${i}: href`).toBe(
            `/product/${encodeURIComponent(item.slug)}`,
          )
          expect(cardRoot.textContent, `card ${i}: name`).toContain(item.name)
          expect(
            cardRoot.querySelectorAll('[data-injected]'),
            `card ${i}: name is text`,
          ).toHaveLength(0)
        }
        expect(root.querySelectorAll('[data-injected]')).toHaveLength(0)
      }),
      { numRuns: 50 },
    )
  })

  it('AC-3: property: the loading, no-term and no-results states render exactly where today’s script renders them, and cards only otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(''), term),
        fc.boolean(),
        results(0, 3),
        fc.option(fc.stringMatching(/^c[0-9]{1,3}$/)),
        async (query, loading, items, nextCursor) => {
          document.body.innerHTML = ''
          client = setupMockClient()
          setSearch({ query, loading, results: items, total: items.length, nextCursor })
          const root = shadow(await mount())

          // The order of `search.ts:61-102`: a first page loading, then no term, then no results, then the grid.
          const expected =
            loading && items.length === 0
              ? 'loading'
              : query === ''
                ? 'no-term'
                : items.length === 0
                  ? 'no-results'
                  : 'grid'
          const shown = headings(root)
          expect(shown.includes(NO_TERM), `no-term heading in state ${expected}`).toBe(
            expected === 'no-term',
          )
          expect(shown.includes(NO_RESULTS), `no-results heading in state ${expected}`).toBe(
            expected === 'no-results',
          )
          expect(cards(root)).toHaveLength(expected === 'grid' ? items.length : 0)
        },
      ),
      { numRuns: 80 },
    )
  })

  it('AC-3: property: search-load-more is present iff nextCursor !== null, and one click calls loadMore() once', async () => {
    await fc.assert(
      fc.asyncProperty(
        term,
        results(1, 4),
        fc.option(fc.stringMatching(/^c[0-9]{1,3}$/)),
        async (query, items, nextCursor) => {
          document.body.innerHTML = ''
          client = setupMockClient()
          const loadMore = vi.fn(async () => undefined)
          Object.assign(client.search, { loadMore })
          setSearch({ query, loading: false, results: items, total: items.length + 5, nextCursor })
          const root = shadow(await mount())

          const buttons = root.querySelectorAll<HTMLElement>('[data-testid="search-load-more"]')
          expect(buttons).toHaveLength(nextCursor !== null ? 1 : 0)
          for (const button of buttons) button.click()
          // One click on the one load-more makes one call; with no next page there is nothing to click.
          expect(loadMore.mock.calls.length).toBe(buttons.length)
        },
      ),
      { numRuns: 40 },
    )
  })
})
