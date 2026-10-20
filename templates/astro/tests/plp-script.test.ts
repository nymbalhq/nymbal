// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// P1-11 store walk (Astro): when the listing script (`src/scripts/plp.ts`) re-renders the grid for a new sort, a
// product's name is text, never markup. The grid is rebuilt with `innerHTML`, so a name interpolated unescaped is
// parsed: `<img …>` in a name becomes an element on the shopper's page, and a `"` in it breaks out of the image's
// `alt` attribute. Kills: `renderProductCard` interpolating `product.name` without escaping, in the card's text or
// in the image's alt.
//
// Runs the real script and the real SDK client store over a fake `fetch`; only the storefront's custom elements are
// stubbed. The cheapest layer that sees the defect: the browser parses `innerHTML` as jsdom does.

vi.mock('@nymbalhq/web-components', () => ({
  registerClient: () => undefined,
  registerComponents: () => undefined,
}))

const API = 'http://api.test'

const HOSTILE_NAME = 'Tag "><img src=x data-p111-xss> <b data-p111-xss>bold</b>'

interface FakeProduct {
  id: string
  slug: string
  name: string
  currency: string
  imageUrl: string
  priceRange: { minMinor: number; maxMinor: number }
}

const product = (slug: string, name: string, minMinor: number): FakeProduct => ({
  id: `prod-${slug}`,
  slug,
  name,
  currency: 'GBP',
  imageUrl: `https://img.test/${slug}.jpg`,
  priceRange: { minMinor, maxMinor: minMinor },
})

const NEWEST = [product('plain-mug', 'Plain Mug', 1200), product('plain-tee', 'Plain Tee', 2400)]
const PRICE_DESC = [
  product('xss-name', HOSTILE_NAME, 9900),
  product('plain-tee', 'Plain Tee', 2400),
  product('plain-mug', 'Plain Mug', 1200),
]

function fakeApi() {
  const listings: string[] = []
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.pathname === '/api/products') {
      const sort = url.searchParams.get('sort') ?? 'newest'
      listings.push(sort)
      const items = sort === 'price-desc' ? PRICE_DESC : NEWEST
      return json(200, { data: { items, nextCursor: null } })
    }
    if (url.pathname === '/api/cart')
      return json(404, { error: { code: 'not_found', message: 'no cart' } })
    return json(404, { error: { code: 'not_found', message: url.pathname } })
  }
  return { listings, fetchImpl }
}

/**
 * The markup `src/pages/products/index.astro` gives the script, with the newest order server-rendered. The custom
 * elements are stubbed, so `<nymbal-sort-dropdown>` stays unupgraded and the test emits its event as the element does.
 */
const PLP_MARKUP = `
  <p id="product-count">${NEWEST.length} products</p>
  <nymbal-sort-dropdown value="newest">
    <select id="sort-select" data-testid="sort-dropdown">
      <option value="newest" selected>Newest</option>
      <option value="price-asc">Price: Low to High</option>
      <option value="price-desc">Price: High to Low</option>
      <option value="name-asc">Name: A to Z</option>
      <option value="name-desc">Name: Z to A</option>
    </select>
  </nymbal-sort-dropdown>
  <div class="product-grid" id="product-grid">
    ${NEWEST.map(
      (p) =>
        `<a href="/product/${p.slug}" class="product-card" data-testid="product-card-${p.slug}"><img src="${p.imageUrl}" alt="" /><div class="product-card-body"><span class="product-card-name">${p.name}</span></div></a>`,
    ).join('')}
  </div>
  <button id="load-more-btn" type="button" data-testid="load-more">Load more</button>
`

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Store walk: the Astro listing script renders product names as text', () => {
  it('Store walk: after a sort change, a product named with markup shows its name literally, in the card and in the image alt, and adds no element', async () => {
    const api = fakeApi()
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    vi.stubEnv('PUBLIC_NYMBAL_API_URL', API)
    vi.resetModules()
    document.body.innerHTML = PLP_MARKUP
    await import('../src/scripts/plp')
    const { client } = await import('../src/lib/client')

    // The script's own first load has answered, so the change below is not raced by it.
    await vi.waitFor(() => {
      expect(api.listings.length).toBeGreaterThan(0)
      expect(client.productList.getState().loading).toBe(false)
    })

    // The sort element's own event, which it emits whichever select it renders; the select itself is not touched.
    document.querySelector('nymbal-sort-dropdown')!.dispatchEvent(
      new CustomEvent('nymbal:sort:changed', {
        bubbles: true,
        composed: true,
        detail: { sort: 'price-desc' },
      }),
    )

    const cards = () => [
      ...document.querySelectorAll<HTMLElement>('[data-testid^="product-card-"]'),
    ]
    await vi.waitFor(() =>
      expect(cards().map((c) => c.dataset.testid)).toEqual(
        PRICE_DESC.map((p) => `product-card-${p.slug}`),
      ),
    )

    // Each card shows its product's name as text, in the card body and in the image's alt.
    expect(cards().map((c) => c.querySelector('.product-card-name')?.textContent)).toEqual(
      PRICE_DESC.map((p) => p.name),
    )
    expect(cards().map((c) => c.querySelector('img')?.getAttribute('alt'))).toEqual(
      PRICE_DESC.map((p) => p.name),
    )
    expect(document.querySelectorAll('[data-p111-xss]').length).toBe(0)
  })
})
