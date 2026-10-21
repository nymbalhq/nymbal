import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as wc from './index.js'
import type { ElementSchema } from './index.js'
import { setupMockClient } from './testing/index.js'

// P2-06 AC-1: every element `registerComponents()` defines (tests/setup.ts calls it) is a LitElement whose static
// `schema` names the tag it is defined under; every one but `nymbal-payment-element` renders in an open shadow root;
// and the `part`s it renders are exactly the ones its schema lists, so a project can know every part it may style.
// The states driven per element are the render branches each element has today (empty and filled store, loading,
// open, error), seeded through the mock client's stores.

const PAYMENT = 'nymbal-payment-element'
const TAGS = [
  'nymbal-add-to-cart',
  'nymbal-cart-drawer',
  'nymbal-mini-cart',
  'nymbal-variant-selector',
  'nymbal-quantity-selector',
  'nymbal-search-bar',
  'nymbal-product-filter',
  'nymbal-toast',
  PAYMENT,
  'nymbal-sort-dropdown',
] as const
type Tag = (typeof TAGS)[number]

type StoreName = 'cart' | 'product' | 'search' | 'productList'
type ToastType = 'success' | 'error' | 'warning' | 'info'

/** One state of one element: its attributes, what its stores hold before it connects, and toasts shown after. */
interface State {
  attrs: Record<string, string>
  stores: Partial<Record<StoreName, Record<string, unknown>>>
  toasts: Array<{ message: string; type: ToastType }>
}

const state = (partial: Partial<State> = {}): State => ({
  attrs: {},
  stores: {},
  toasts: [],
  ...partial,
})

function schemaOf(ctor: unknown): ElementSchema | undefined {
  return (ctor as { schema?: ElementSchema } | undefined)?.schema
}

/** Creates the element in `s`, connected, once its render has settled. */
async function mount(tag: Tag, s: State): Promise<HTMLElement> {
  const client = setupMockClient() as unknown as Record<
    StoreName,
    { setState(partial: Record<string, unknown>): void }
  >
  for (const [name, partial] of Object.entries(s.stores)) {
    client[name as StoreName].setState(partial)
  }
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(s.attrs)) el.setAttribute(name, value)
  document.body.appendChild(el)
  await settled(el)
  for (const t of s.toasts) {
    ;(el as unknown as { show(message: string, type: ToastType): void }).show(t.message, t.type)
  }
  await settled(el)
  return el
}

async function settled(el: HTMLElement): Promise<void> {
  await (el as unknown as { updateComplete?: Promise<unknown> }).updateComplete
}

/** Every part name the element renders in its own render root (its shadow root, or itself in the light DOM). */
function renderedParts(el: HTMLElement): string[] {
  const root: ParentNode = el.shadowRoot ?? el
  return [...root.querySelectorAll('[part]')].flatMap((node) =>
    (node.getAttribute('part') ?? '').split(/\s+/).filter((p) => p !== ''),
  )
}

// ─── Store data ─────────────────────────────────────────────────────────────

const word = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/)

const cartItem = fc.record({
  variantId: word,
  productName: word,
  variantName: word,
  qty: fc.integer({ min: 1, max: 9 }),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
})

function cartOf<T extends { qty: number; priceMinor: number }>(items: T[], loading = false) {
  return {
    items,
    itemCount: items.reduce((n, i) => n + i.qty, 0),
    subtotalMinor: items.reduce((n, i) => n + i.qty * i.priceMinor, 0),
    currency: 'GBP',
    loading,
    error: null,
  }
}

const option = fc.record({ name: fc.constantFrom('Size', 'Colour'), value: word })

function productOf(variantOptions: Array<Array<{ name: string; value: string }>>) {
  const variants = variantOptions.map((options, i) => ({
    id: `v${i}`,
    sku: `SKU-${i}`,
    name: `Variant ${i}`,
    priceMinor: 1000 + i,
    stock: 5,
    options,
  }))
  return {
    id: 'p1',
    slug: 'p1',
    name: 'Product',
    description: '',
    shortDescription: '',
    status: 'active',
    type: 'physical',
    media: [],
    variantCount: variants.length,
    inStock: true,
    priceRange: null,
    currency: 'GBP',
    priceMinor: 1000,
    variants,
  }
}

const facetValue = fc.record(
  { value: word, label: word, count: fc.integer({ min: 0, max: 50 }) },
  { requiredKeys: ['value'] },
)
const facet = fc.record({
  field: fc.constantFrom('category', 'colour'),
  label: word,
  values: fc.array(facetValue, { maxLength: 4 }),
})

const searchResult = fc.record({
  slug: word,
  name: word,
  priceMinor: fc.option(fc.integer({ min: 0, max: 100_000 })),
  currency: fc.constant('GBP'),
})

const SORT_KEYS = ['newest', 'price-asc', 'price-desc', 'name-asc']

// ─── States per element: the fixed branches, and an arbitrary over each ──────

const FIXED: Record<Tag, State[]> = {
  'nymbal-add-to-cart': [
    state(),
    state({ attrs: { 'variant-id': 'v1' } }),
    state({ attrs: { 'variant-id': 'v1', disabled: '' } }),
    state({ attrs: { 'variant-id': 'v1' }, stores: { cart: cartOf([], true) } }),
  ],
  'nymbal-cart-drawer': [
    state(),
    state({ attrs: { open: '' } }),
    state({
      attrs: { open: '' },
      stores: {
        cart: cartOf([
          { variantId: 'v1', productName: 'Mug', variantName: 'Blue', qty: 2, priceMinor: 1200 },
        ]),
      },
    }),
  ],
  'nymbal-mini-cart': [
    state(),
    state({
      stores: {
        cart: cartOf([
          { variantId: 'v1', productName: 'Mug', variantName: 'Blue', qty: 3, priceMinor: 1200 },
        ]),
      },
    }),
  ],
  'nymbal-variant-selector': [
    state(),
    state({
      stores: {
        product: {
          product: productOf([
            [{ name: 'Size', value: 's' }],
            [{ name: 'Size', value: 'm' }],
          ]),
          selectedVariant: null,
        },
      },
    }),
  ],
  'nymbal-quantity-selector': [
    state(),
    state({ attrs: { value: '1', min: '1', max: '5' } }),
    state({ attrs: { value: '5', min: '1', max: '5' } }),
  ],
  'nymbal-search-bar': [
    state(),
    state({ stores: { search: { query: 'mug', loading: true, results: [] } } }),
    state({
      stores: {
        search: {
          query: 'mug',
          loading: false,
          results: [{ slug: 'mug', name: 'Mug', priceMinor: 1200, currency: 'GBP' }],
        },
      },
    }),
  ],
  'nymbal-product-filter': [
    state(),
    state({
      attrs: {
        facets: JSON.stringify([
          { field: 'colour', label: 'Colour', values: [{ value: 'red', count: 2 }] },
        ]),
      },
    }),
    state({ attrs: { source: 'search' } }),
    state({
      attrs: { source: 'search' },
      stores: {
        search: {
          facets: [
            { field: 'category', label: 'Category', values: [{ value: 'home', count: 3 }] },
          ],
          category: 'home',
        },
      },
    }),
  ],
  'nymbal-toast': [
    state(),
    state({
      toasts: [
        { message: 'Added', type: 'success' },
        { message: 'Failed', type: 'error' },
      ],
    }),
  ],
  [PAYMENT]: [
    state(),
    state({ attrs: { client: 'not json' } }),
    state({ attrs: { client: JSON.stringify({ driver: 'no-such-driver', options: {} }) } }),
  ],
  'nymbal-sort-dropdown': [
    state(),
    state({ attrs: { 'sort-keys': JSON.stringify(SORT_KEYS), value: 'price-asc' } }),
  ],
}

const ARBITRARY: Record<Tag, fc.Arbitrary<State>> = {
  'nymbal-add-to-cart': fc
    .record({ variant: fc.option(word), disabled: fc.boolean(), loading: fc.boolean() })
    .map(({ variant, disabled, loading }) =>
      state({
        attrs: {
          ...(variant !== null && { 'variant-id': variant }),
          ...(disabled && { disabled: '' }),
        },
        stores: { cart: cartOf([], loading) },
      }),
    ),
  'nymbal-cart-drawer': fc
    .record({ items: fc.array(cartItem, { maxLength: 4 }), open: fc.boolean() })
    .map(({ items, open }) =>
      state({ attrs: open ? { open: '' } : {}, stores: { cart: cartOf(items) } }),
    ),
  'nymbal-mini-cart': fc
    .array(cartItem, { maxLength: 4 })
    .map((items) => state({ stores: { cart: cartOf(items) } })),
  'nymbal-variant-selector': fc
    .option(fc.array(fc.array(option, { maxLength: 2 }), { minLength: 1, maxLength: 4 }))
    .map((variants) =>
      state({
        stores: {
          product: { product: variants === null ? null : productOf(variants), selectedVariant: null },
        },
      }),
    ),
  'nymbal-quantity-selector': fc
    .record({
      min: fc.integer({ min: 1, max: 5 }),
      span: fc.integer({ min: 0, max: 10 }),
      at: fc.integer({ min: 0, max: 10 }),
    })
    .map(({ min, span, at }) =>
      state({
        attrs: {
          min: String(min),
          max: String(min + span),
          value: String(min + Math.min(at, span)),
        },
      }),
    ),
  'nymbal-search-bar': fc
    .record({
      query: fc.oneof(fc.constant(''), word),
      loading: fc.boolean(),
      results: fc.array(searchResult, { maxLength: 4 }),
    })
    .map((search) => state({ stores: { search } })),
  'nymbal-product-filter': fc
    .record({ search: fc.boolean(), facets: fc.array(facet, { maxLength: 3 }) })
    .map(({ search, facets }) =>
      search
        ? state({ attrs: { source: 'search' }, stores: { search: { facets, category: null } } })
        : state({ attrs: { facets: JSON.stringify(facets) } }),
    ),
  'nymbal-toast': fc
    .array(
      fc.record({ message: word, type: fc.constantFrom<ToastType>('success', 'error', 'warning', 'info') }),
      { maxLength: 3 },
    )
    .map((toasts) => state({ toasts })),
  [PAYMENT]: fc
    .constantFrom(null, 'not json', JSON.stringify({ driver: 'no-such-driver', options: {} }))
    .map((client) => state({ attrs: client === null ? {} : { client } })),
  'nymbal-sort-dropdown': fc
    .record({ keys: fc.subarray(SORT_KEYS), value: fc.constantFrom(...SORT_KEYS) })
    .map(({ keys, value }) => state({ attrs: { 'sort-keys': JSON.stringify(keys), value } })),
}

describe('P2-06 AC-1: elements are Lit, in an open shadow root, with the parts their schema lists', () => {
  it('AC-1: every element registerComponents() defines is a LitElement, and its schema.tag is the name it is defined under', async () => {
    // Lit is the dependency the spec adds; imported at run time so the other cases still report their own red.
    const lit = 'lit'
    const { LitElement } = (await import(/* @vite-ignore */ lit)) as {
      LitElement: typeof HTMLElement
    }
    for (const tag of TAGS) {
      const ctor = customElements.get(tag)
      expect(ctor, `${tag} is defined`).toBeDefined()
      expect(ctor?.prototype instanceof LitElement, `${tag} is a LitElement`).toBe(true)
      expect(schemaOf(ctor)?.tag, `${tag}'s schema.tag`).toBe(tag)
    }
    // Every element class the package exports is the one defined under its schema's tag.
    const exported = Object.values(wc).filter((v) => schemaOf(v) !== undefined)
    expect(exported.map((ctor) => schemaOf(ctor)!.tag).sort()).toEqual([...TAGS].sort())
    for (const ctor of exported) {
      expect(customElements.get(schemaOf(ctor)!.tag)).toBe(ctor)
    }
  })

  it('AC-1: every element but nymbal-payment-element has an open shadowRoot once connected; the payment element renders in the light DOM', async () => {
    for (const tag of TAGS) {
      const el = await mount(tag, state())
      expect(el.shadowRoot?.mode ?? 'light DOM', tag).toBe(tag === PAYMENT ? 'light DOM' : 'open')
    }
  })

  it('AC-1: the parts each element renders across its states are exactly its schema.parts', async () => {
    for (const tag of TAGS) {
      const schema = schemaOf(customElements.get(tag))
      expect(schema, `${tag} declares a static schema`).toBeDefined()
      const seen = new Set<string>()
      for (const s of FIXED[tag]) {
        for (const part of renderedParts(await mount(tag, s))) seen.add(part)
        document.body.innerHTML = ''
      }
      expect([...seen].sort(), `${tag}: rendered parts`).toEqual([...(schema?.parts ?? [])].sort())
    }
  })

  it('AC-1: property: no element renders a part its schema does not list, over generated store states', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TAGS).chain((tag) => ARBITRARY[tag].map((s) => ({ tag, s }))),
        async ({ tag, s }) => {
          document.body.innerHTML = ''
          const schema = schemaOf(customElements.get(tag))
          expect(schema, `${tag} declares a static schema`).toBeDefined()
          const listed = new Set(schema?.parts ?? [])
          const el = await mount(tag, s)
          const unlisted = renderedParts(el).filter((part) => !listed.has(part))
          expect(unlisted, `${tag} renders parts its schema does not list`).toEqual([])
        },
      ),
      { numRuns: 150 },
    )
  })
})
