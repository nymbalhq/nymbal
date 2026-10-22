import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import { renderElement } from '../ssr/index.js'
import { STOCK_LABELS, stockLevel } from '@nymbalhq/types'
import {
  addresses,
  cards,
  cart,
  customer,
  facets,
  formatMoney,
  optionValuesOf,
  pdpProduct,
  variantProduct,
  type CartProjection,
} from '../__fixtures__/server-data.js'

// P2-18 AC-2 (spec Decision 2): an element the server rendered from a property keeps showing that property's data
// once it has a client, until its store's first settled update (`loading: false`); an update with `loading: true`
// (the cart store's first, `cart-store.ts:38`) leaves it showing; after the settled one the element shows the store's
// data. With no property and a client it shows the store's, as before. The store is empty when the element connects,
// so a property that is ignored shows the empty state. Kills: an element that ignores its property, drops it on the
// `loading: true` update (the header badge flips 1 → 0 → 1), or keeps it after the store settled.
//
// Data from a property is prefixed `p-`, from a store `s-`, so the two are never mistaken for each other.

type Store = { setState(partial: Record<string, unknown>): void }
type Client = Record<string, Store> & Record<string, unknown>

function client(): Client {
  return setupMockClient() as unknown as Client
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

async function mount(tag: string, attributes: Record<string, string> = {}): Promise<HTMLElement> {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
  document.body.append(el)
  await settled(el)
  return el
}

async function update(el: Element, store: Store, partial: Record<string, unknown>): Promise<void> {
  store.setState(partial)
  await settled(el)
}

function shadow(el: Element): ShadowRoot {
  if (el.shadowRoot === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return el.shadowRoot
}

/** The trimmed text of every node carrying `part` in the element's shadow root, in order. */
function partTexts(el: Element, part: string): string[] {
  return [...shadow(el).querySelectorAll(`[part~="${part}"]`)].map((n) =>
    (n.textContent ?? '').trim(),
  )
}

const names = (c: CartProjection): string[] => c.items.map((i) => i.productName)
const settledCart = (c: CartProjection) => ({ ...c, loading: false, error: null })

/** The cart elements: each shows its lines' names in `[part~=item-name]`. */
for (const tag of ['nymbal-cart-page', 'nymbal-checkout', 'nymbal-cart-drawer']) {
  describe(`P2-18 AC-2: ${tag}`, () => {
    it(`AC-2: property: ${tag} shows its cart property's lines through a loading update, the cart store's after the first settled one, and the store's with no property`, async () => {
      await fc.assert(
        fc.asyncProperty(cart('p-', 1), cart('s-', 1), async (property, stored) => {
          const c = client()
          const el = await mount(tag, { cart: JSON.stringify(property) })
          expect(partTexts(el, 'item-name')).toEqual(names(property))

          await update(el, c['cart']!, { loading: true })
          expect(partTexts(el, 'item-name'), 'after loading: true').toEqual(names(property))

          await update(el, c['cart']!, settledCart(stored))
          expect(partTexts(el, 'item-name'), 'after the store settled').toEqual(names(stored))
          el.remove()

          const plain = await mount(tag)
          expect(partTexts(plain, 'item-name'), 'no property').toEqual(names(stored))
          plain.remove()
        }),
        { numRuns: 10 },
      )
    })

    // A store that settled before the element connected (Next's router restoring a cached page after the cart
    // changed elsewhere) gives no update after subscription, so the stale property must give way at connect, both on a
    // plain mount and once a host given the server's string has hydrated it. Kills: a property dropped only by a later
    // update, which shows one cart beside a badge and an order of another.
    it(`AC-2: property: ${tag} connected with a cart property while the cart store has already settled shows the store's lines when mounted, and lets the property go once it has hydrated the server's render`, async () => {
      await fc.assert(
        fc.asyncProperty(cart('p-', 1), cart('s-', 1), async (property, stored) => {
          const c = client()
          c['cart']!.setState(settledCart(stored))

          const el = await mount(tag, { cart: JSON.stringify(property) })
          expect(partTexts(el, 'item-name'), 'mounted').toEqual(names(stored))
          el.remove()

          // Parsed detached, then inserted, so the element connects with the server's template as its child (happy-dom
          // parses into a connected parent node by node, and the element would connect before the template exists).
          const container = document.createElement('div')
          container.innerHTML = renderElement(tag, {
            attributes: { cart: JSON.stringify(property) },
          })
          document.body.append(container)
          const hydrated = container.firstElementChild!
          await settled(hydrated)
          expect(
            [...hydrated.children].some((ch) => ch.localName === 'template'),
            'the server template became the shadow root',
          ).toBe(false)
          // happy-dom's TreeWalker does not descend past a filtered first child, so Lit's hydration binds no parts
          // here and the shadow DOM cannot change after it: what is observable is that the property gave way once
          // the server's render was hydrated (the browser re-render is the E2E journeys').
          expect(
            (hydrated as Element & { cart?: unknown }).cart,
            'the cart property gave way',
          ).toBe(undefined)
          container.remove()
        }),
        { numRuns: 10 },
      )
    })
  })
}

describe('P2-18 AC-2: nymbal-mini-cart', () => {
  const badge = (el: Element): string => partTexts(el, 'badge')[0] ?? ''
  const shown = (n: number): string => (n > 0 ? String(n) : '')

  it('AC-2: property: nymbal-mini-cart shows its count through a loading update (no 1 → 0 → 1 flip), the store’s itemCount after the first settled one, and the store’s with no count', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        async (count, stored) => {
          const c = client()
          const el = await mount('nymbal-mini-cart', { count: String(count) })
          expect(badge(el)).toBe(shown(count))

          await update(el, c['cart']!, { loading: true })
          expect(badge(el), 'after loading: true').toBe(shown(count))

          await update(el, c['cart']!, { loading: false, itemCount: stored })
          expect(badge(el), 'after the store settled').toBe(shown(stored))
          el.remove()

          const plain = await mount('nymbal-mini-cart')
          expect(badge(plain), 'no property').toBe(shown(stored))
          plain.remove()
        },
      ),
      { numRuns: 15 },
    )
  })
})

describe('P2-18 AC-2: nymbal-search-results', () => {
  /** The slugs of the product cards the results render, in order. */
  const slugs = (el: Element): string[] =>
    [...shadow(el).querySelectorAll('nymbal-product-card')].map(
      (c) => (JSON.parse(c.getAttribute('product') ?? '{}') as { slug?: string }).slug ?? '',
    )

  it('AC-2: property: nymbal-search-results shows its results property’s cards through a loading update, the search store’s after the first settled one, and the store’s with no property', async () => {
    await fc.assert(
      fc.asyncProperty(cards('p-', 1), cards('s-', 1), async (property, stored) => {
        const c = client()
        const el = await mount('nymbal-search-results', { results: JSON.stringify(property) })
        expect(slugs(el)).toEqual(property.map((p) => p.slug))

        await update(el, c['search']!, { loading: true })
        expect(slugs(el), 'after loading: true').toEqual(property.map((p) => p.slug))

        const search = { query: 'wool', results: stored, total: stored.length, nextCursor: null }
        await update(el, c['search']!, { ...search, loading: false })
        expect(slugs(el), 'after the store settled').toEqual(stored.map((p) => p.slug))
        el.remove()

        const plain = await mount('nymbal-search-results')
        expect(slugs(plain), 'no property').toEqual(stored.map((p) => p.slug))
        plain.remove()
      }),
      { numRuns: 10 },
    )
  })
})

describe('P2-18 AC-2: nymbal-variant-selector', () => {
  const options = (el: Element): string[] => partTexts(el, 'option').sort()

  it('AC-2: property: nymbal-variant-selector shows its product property’s options through a loading update, the product store’s after the first settled one, and the store’s with no property', async () => {
    await fc.assert(
      fc.asyncProperty(variantProduct('p-'), variantProduct('s-'), async (property, stored) => {
        const c = client()
        const el = await mount('nymbal-variant-selector', { product: JSON.stringify(property) })
        expect(options(el)).toEqual(optionValuesOf(property))

        await update(el, c['product']!, { loading: true })
        expect(options(el), 'after loading: true').toEqual(optionValuesOf(property))

        await update(el, c['product']!, { product: stored, selectedVariant: null, loading: false })
        expect(options(el), 'after the store settled').toEqual(optionValuesOf(stored))
        el.remove()

        const plain = await mount('nymbal-variant-selector')
        expect(options(plain), 'no property').toEqual(optionValuesOf(stored))
        plain.remove()
      }),
      { numRuns: 10 },
    )
  })
})

describe('P2-18 AC-2: nymbal-product-filter', () => {
  const labels = (el: Element): string[] => partTexts(el, 'option-label')
  const labelsOf = (list: Array<{ values: Array<{ label: string }> }>): string[] =>
    list.flatMap((f) => f.values.map((v) => v.label))

  it('AC-2: property: nymbal-product-filter source="search" shows its facets attribute through a loading update, the search store’s category facets after the first settled one, and the store’s with no attribute', async () => {
    const category = fc.constant('category')
    await fc.assert(
      fc.asyncProperty(facets('p-', category), facets('s-', category), async (property, stored) => {
        const c = client()
        const el = await mount('nymbal-product-filter', {
          source: 'search',
          facets: JSON.stringify(property),
        })
        expect(labels(el)).toEqual(labelsOf(property))

        await update(el, c['search']!, { loading: true })
        expect(labels(el), 'after loading: true').toEqual(labelsOf(property))

        await update(el, c['search']!, { facets: stored, loading: false })
        expect(labels(el), 'after the store settled').toEqual(labelsOf(stored))
        el.remove()

        const plain = await mount('nymbal-product-filter', { source: 'search' })
        expect(labels(plain), 'no attribute').toEqual(labelsOf(stored))
        plain.remove()
      }),
      { numRuns: 10 },
    )
  })
})

describe('P2-18 AC-2: nymbal-profile-form', () => {
  /** The values the form's fields show, by field name. */
  const fields = (el: Element): Record<string, string> =>
    Object.fromEntries([...shadow(el).querySelectorAll('input')].map((i) => [i.name, i.value]))
  const of = (c: { firstName: string; lastName: string; email: string }) => ({
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
  })
  const shownOf = (el: Element) => {
    const f = fields(el)
    return { firstName: f['firstName'], lastName: f['lastName'], email: f['email'] }
  }

  it('AC-2: property: nymbal-profile-form shows its customer property through a loading update, the auth store’s customer after the first settled one, and the store’s with no property', async () => {
    await fc.assert(
      fc.asyncProperty(customer('p-'), customer('s-'), async (property, stored) => {
        const c = client()
        const el = await mount('nymbal-profile-form', { customer: JSON.stringify(property) })
        expect(shownOf(el)).toEqual(of(property))

        await update(el, c['auth']!, { loading: true })
        expect(shownOf(el), 'after loading: true').toEqual(of(property))

        await update(el, c['auth']!, { customer: stored, isAuthenticated: true, loading: false })
        expect(shownOf(el), 'after the store settled').toEqual(of(stored))
        el.remove()

        const plain = await mount('nymbal-profile-form')
        expect(shownOf(plain), 'no property').toEqual(of(stored))
        plain.remove()
      }),
      { numRuns: 10 },
    )
  })
})

describe('P2-18 AC-2: nymbal-address-book', () => {
  /** The ids of the addresses the book lists, in order. */
  // The part token read exactly: happy-dom's `[part~="address"]` also matches `address-line` and `address-badge`.
  const listed = (el: Element): string[] =>
    [...shadow(el).querySelectorAll('[part]')]
      .filter((n) => (n.getAttribute('part') ?? '').split(/\s+/).includes('address'))
      .map((n) => (n.getAttribute('data-testid') ?? '').replace(/^address-/, ''))

  /** The address book has no store: its settled update is the answer to `customer.addresses.list()`. */
  function heldList(c: Client): { answer(list: unknown[]): Promise<void> } {
    let release: (list: unknown[]) => void = () => undefined
    const pending = new Promise<unknown[]>((resolve) => {
      release = resolve
    })
    ;(c as Record<string, unknown>)['customer'] = { addresses: { list: () => pending } }
    return {
      answer: async (list) => {
        release(list)
        await pending
      },
    }
  }

  it('AC-2: property: nymbal-address-book shows its addresses property while the list call is in flight, the list’s answer once it settles, and the answer with no property', async () => {
    await fc.assert(
      fc.asyncProperty(addresses('p-', 1), addresses('s-', 1), async (property, stored) => {
        const c = client()
        const list = heldList(c)
        const el = await mount('nymbal-address-book', { addresses: JSON.stringify(property) })
        expect(listed(el)).toEqual(property.map((a) => a.id))

        await list.answer(stored)
        await settled(el)
        await settled(el)
        expect(listed(el), 'after the list settled').toEqual(stored.map((a) => a.id))
        el.remove()

        const plain = await mount('nymbal-address-book')
        await settled(plain)
        expect(listed(plain), 'no property').toEqual(stored.map((a) => a.id))
        plain.remove()
      }),
      { numRuns: 10 },
    )
  })
})

// ─── P2-17 AC-2 (spec Decision 1): the grid, the PDP's price and its stock badge ─────────────────────────────────
//
// The same rule for the three store-backed elements P2-17 adds. `nymbal-product-grid` with `source="product-list"`
// shows its `products` attribute's cards until the product-list store's first settled update, then the store's items
// in the store's order, following every later settled update (a sort, a load-more). `nymbal-product-price` and
// `nymbal-stock-badge` show their attributes until the product store settles on the product their `product-id` names,
// then the selected variant's price and stock, following `selectVariant`; a store settled on another product (the one a
// Next soft navigation PDP → PDP left behind) is ignored. The badge's level and label are the one rule of
// @nymbalhq/types (P2-12), negatives included; the two tests that held that rule over the templates' badges
// (templates/{astro,nextjs}/tests/stock-badge.test.*) go with the badges. Kills: a grid that re-renders from its
// attribute after the store moved, or shows the store before it settled; a price or badge that ignores the selected
// variant, follows another product's store, or keeps a rule of its own.

describe('P2-17 AC-2: nymbal-product-grid source="product-list"', () => {
  /** The slugs of the cards the grid renders, in order. */
  const slugs = (el: Element): string[] =>
    [...shadow(el).querySelectorAll('nymbal-product-card')].map(
      (c) => (JSON.parse(c.getAttribute('product') ?? '{}') as { slug?: string }).slug ?? '',
    )
  const listed = (products: Array<{ slug: string }>, cursor: string | null) => ({
    products,
    pagination: { cursor, hasMore: cursor !== null },
    loading: false,
    error: null,
  })

  it('AC-2: property: the grid shows its products attribute’s cards through a loading update, the store’s items in the store’s order after the first settled one and after each later one (sort orders), and the store’s with no attribute', async () => {
    expect(
      customElements.get('nymbal-product-grid'),
      'nymbal-product-grid is defined by registerComponents()',
    ).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        cards('p-', 1),
        cards('s-', 1).chain((stored) =>
          fc.tuple(
            fc.constant(stored),
            fc.array(fc.shuffledSubarray(stored, { minLength: stored.length }), {
              minLength: 1,
              maxLength: 3,
            }),
          ),
        ),
        async (property, [stored, orders]) => {
          const c = client()
          const el = await mount('nymbal-product-grid', {
            source: 'product-list',
            products: JSON.stringify(property),
          })
          expect(slugs(el)).toEqual(property.map((p) => p.slug))

          await update(el, c['productList']!, { loading: true })
          expect(slugs(el), 'after loading: true').toEqual(property.map((p) => p.slug))

          await update(el, c['productList']!, listed(stored, null))
          expect(slugs(el), 'after the store settled').toEqual(stored.map((p) => p.slug))

          for (const order of orders) {
            await update(el, c['productList']!, { loading: true })
            await update(el, c['productList']!, listed(order, null))
            expect(slugs(el), 'after a re-sort settled').toEqual(order.map((p) => p.slug))
          }
          el.remove()

          const plain = await mount('nymbal-product-grid', { source: 'product-list' })
          expect(slugs(plain), 'no attribute').toEqual(orders.at(-1)!.map((p) => p.slug))
          plain.remove()
        },
      ),
      { numRuns: 10 },
    )
  })
})

/** A store's product with variant `i` selected, settled. */
const selected = (product: { variants: unknown[] }, i: number) => ({
  product,
  selectedVariant: product.variants[i],
  loading: false,
  error: null,
})

describe('P2-17 AC-2: nymbal-product-price', () => {
  const price = (el: Element): string[] => partTexts(el, 'price')

  it('AC-2: property: the price shows its price-minor through a loading update and while the store holds another product, the selected variant’s price once the store settles on its product-id, and each variant selectVariant chooses after', async () => {
    expect(
      customElements.get('nymbal-product-price'),
      'nymbal-product-price is defined by registerComponents()',
    ).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100_000 }),
        pdpProduct('s-'),
        pdpProduct('o-'),
        fc.array(fc.nat(), { maxLength: 4 }),
        async (attribute, product, other, picks) => {
          const c = client()
          const el = await mount('nymbal-product-price', {
            'product-id': product.id,
            'price-minor': String(attribute),
            currency: 'GBP',
          })
          const shown = [formatMoney(attribute)]
          expect(price(el)).toEqual(shown)
          expect(
            shadow(el).querySelector('[part~="price"]')?.getAttribute('data-testid'),
            'the price part carries data-testid="product-price"',
          ).toBe('product-price')

          await update(el, c['product']!, { loading: true })
          expect(price(el), 'after loading: true').toEqual(shown)

          await update(el, c['product']!, selected(other, 0))
          expect(price(el), 'the store settled on another product').toEqual(shown)

          await update(el, c['product']!, selected(product, 0))
          expect(price(el), 'settled on this product').toEqual([
            formatMoney(product.variants[0]!.priceMinor),
          ])

          for (const pick of picks) {
            const variant = product.variants[pick % product.variants.length]!
            await update(el, c['product']!, { selectedVariant: variant })
            expect(price(el), `selectVariant(${variant.id})`).toEqual([
              formatMoney(variant.priceMinor),
            ])
          }
          el.remove()

          const plain = await mount('nymbal-product-price', { 'product-id': product.id })
          const now = (
            c['product'] as unknown as { getState(): { selectedVariant: { priceMinor: number } } }
          ).getState().selectedVariant
          expect(price(plain), 'no price-minor').toEqual([formatMoney(now.priceMinor)])
          plain.remove()
        },
      ),
      { numRuns: 15 },
    )
  })

  it('AC-2: property: connected while the product store has already settled, the price shows the store’s selected variant when it is its product, and its own price-minor when it is another', async () => {
    expect(
      customElements.get('nymbal-product-price'),
      'nymbal-product-price is defined by registerComponents()',
    ).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100_000 }),
        pdpProduct('s-'),
        fc.boolean(),
        async (attribute, product, same) => {
          const c = client()
          c['product']!.setState(selected(product, product.variants.length - 1))
          const el = await mount('nymbal-product-price', {
            'product-id': same ? product.id : `${product.id}-other`,
            'price-minor': String(attribute),
            currency: 'GBP',
          })
          expect(price(el)).toEqual([
            formatMoney(same ? product.variants.at(-1)!.priceMinor : attribute),
          ])
          el.remove()
        },
      ),
      { numRuns: 15 },
    )
  })
})

describe('P2-17 AC-2: nymbal-stock-badge', () => {
  /** The badge's level and label, as the shopper's page shows them. */
  const badge = (el: Element) => {
    const node = shadow(el).querySelector('[part~="badge"]')
    return {
      testid: node?.getAttribute('data-testid') ?? null,
      level: node?.getAttribute('data-level') ?? null,
      label: partTexts(el, 'label').join(' '),
    }
  }
  const expected = (stock: number) => ({
    testid: 'stock-badge',
    level: stockLevel(stock),
    label: STOCK_LABELS[stockLevel(stock)],
  })

  it('AC-2: property: the badge shows data-level = stockLevel(stock) and STOCK_LABELS[level] for its stock attribute (negatives included) through a loading update and another product’s store, then for the selected variant once the store settles on its product-id, and for each variant selectVariant chooses after', async () => {
    expect(
      customElements.get('nymbal-stock-badge'),
      'nymbal-stock-badge is defined by registerComponents()',
    ).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.integer({ min: -20, max: 20 }), fc.integer()),
        pdpProduct('s-'),
        pdpProduct('o-'),
        fc.array(fc.nat(), { maxLength: 4 }),
        async (stock, product, other, picks) => {
          const c = client()
          const el = await mount('nymbal-stock-badge', {
            'product-id': product.id,
            stock: String(stock),
          })
          expect(badge(el)).toEqual(expected(stock))

          await update(el, c['product']!, { loading: true })
          expect(badge(el), 'after loading: true').toEqual(expected(stock))

          await update(el, c['product']!, selected(other, 0))
          expect(badge(el), 'the store settled on another product').toEqual(expected(stock))

          await update(el, c['product']!, selected(product, 0))
          expect(badge(el), 'settled on this product').toEqual(expected(product.variants[0]!.stock))

          for (const pick of picks) {
            const variant = product.variants[pick % product.variants.length]!
            await update(el, c['product']!, { selectedVariant: variant })
            expect(badge(el), `selectVariant(${variant.id})`).toEqual(expected(variant.stock))
          }
          el.remove()
        },
      ),
      { numRuns: 20 },
    )
  })

  it('AC-2: property: connected while the product store has already settled, the badge shows the store’s selected variant when it is its product, and its own stock when it is another', async () => {
    expect(
      customElements.get('nymbal-stock-badge'),
      'nymbal-stock-badge is defined by registerComponents()',
    ).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -5, max: 20 }),
        pdpProduct('s-'),
        fc.boolean(),
        async (stock, product, same) => {
          const c = client()
          c['product']!.setState(selected(product, product.variants.length - 1))
          const el = await mount('nymbal-stock-badge', {
            'product-id': same ? product.id : `${product.id}-other`,
            stock: String(stock),
          })
          expect(badge(el)).toEqual(expected(same ? product.variants.at(-1)!.stock : stock))
          el.remove()
        },
      ),
      { numRuns: 15 },
    )
  })
})
