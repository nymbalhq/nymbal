import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as wc from './index.js'
import type { ElementSchema } from './index.js'
import { setupMockClient } from './testing/index.js'
import { timelineEntries } from './__fixtures__/server-data.js'

// AC-1: every element `registerComponents()` defines (tests/setup.ts calls it) is a LitElement whose static `schema`
// names the tag it is defined under; every one but `nymbal-payment-element` renders in an open shadow root; and the
// `part`s it renders are exactly the ones its schema lists, so a project can know every part it may style. The states
// driven per element are its render branches (empty and filled store, loading, open, error), seeded through the mock
// client's stores.
//
// The views (cart page, product card, search results, the four account forms and the address book) add the signed-in
// customer's addresses, and a form submitted once with its SDK call held, refused or answered.
//
// `nymbal-checkout`'s states are its steps (contact, shipping, payment with billing the same or not), a place-order
// held, refused and answered, a payment element in error, and a cart in its summary; each is reached by walking the
// steps as a shopper does, with the payment element as its `payment`-slotted child.
//
// The catalogue and page elements (grid, price, stock badge, breadcrumb, gallery, header, footer, category nav,
// reviews, order summary, order timeline) render exactly their schema's parts across their states (an empty and a
// filled grid with and without the product-list store, a gallery of none, one and several images, a review form
// submitted once with its call held, refused and answered, an order with and without a discount, a timeline with no
// entry and with several), style them on `--nymbal-*` tokens, have
// their `src/elements/<tag>.ts` entry, and carry the interface the templates call them by.

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
  // Views
  'nymbal-cart-page',
  'nymbal-product-card',
  'nymbal-search-results',
  'nymbal-login-form',
  'nymbal-register-form',
  'nymbal-profile-form',
  'nymbal-address-form',
  'nymbal-address-book',
  // Checkout
  'nymbal-checkout',
  // Catalogue and page elements
  'nymbal-product-grid',
  'nymbal-product-price',
  'nymbal-stock-badge',
  'nymbal-breadcrumb',
  'nymbal-image-gallery',
  'nymbal-site-header',
  'nymbal-site-footer',
  'nymbal-category-nav',
  'nymbal-review-list',
  'nymbal-review-form',
  'nymbal-order-summary',
  'nymbal-order-timeline',
] as const
type Tag = (typeof TAGS)[number]

type StoreName = 'cart' | 'product' | 'search' | 'productList' | 'auth'
type ToastType = 'success' | 'error' | 'warning' | 'info'
/** A form submitted once after it renders: its SDK call never answers, is refused, or succeeds. */
type Phase = 'pending' | 'failed' | 'succeeded'

/** One state of one element: its attributes, what its stores hold before it connects, and toasts shown after. */
interface State {
  attrs: Record<string, string>
  stores: Partial<Record<StoreName, Record<string, unknown>>>
  toasts: Array<{ message: string; type: ToastType }>
  /** What `client.customer.addresses.list()` answers, or `'fail'` when it rejects. */
  addresses: unknown[] | 'fail'
  /** When set, the element's form is filled and submitted once after it renders. */
  phase: Phase | null
  /** Children appended before the element connects (the checkout's payment element). */
  children?: () => Node[]
  /** Drives the element, once rendered, into the state under test (the checkout's steps). */
  walk?: (el: HTMLElement) => Promise<void>
  /** What the checkout store's `submitPayment()` does: never answers, refuses, or places an order. */
  placeOrder?: Phase
}

const state = (partial: Partial<State> = {}): State => ({
  attrs: {},
  stores: {},
  toasts: [],
  addresses: [],
  phase: null,
  ...partial,
})

const CUSTOMER = {
  id: 'cus-1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '+447700900000',
  addresses: [],
  orderCount: 0,
  totalSpentMinor: 0,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
}

/** The account SDK calls the forms make, answering as `s.phase` says; the mock client has no `customer`. */
function installAccount(client: Record<string, unknown>, s: State): void {
  const answer = (): Promise<void> =>
    s.phase === 'pending'
      ? new Promise<void>(() => undefined)
      : s.phase === 'failed'
        ? Promise.reject(new Error('Refused by the AC-1 fake.'))
        : Promise.resolve()
  const auth = client['auth'] as Record<string, unknown> & {
    setState(partial: Record<string, unknown>): void
  }
  const signIn = async (): Promise<void> => {
    await answer()
    auth.setState({ customer: CUSTOMER, isAuthenticated: true })
  }
  auth['login'] = signIn
  auth['register'] = signIn
  auth['updateProfile'] = () => answer()
  client['customer'] = {
    addresses: {
      list: async () => {
        if (s.addresses === 'fail') throw new Error('Unavailable')
        return s.addresses
      },
      create: async (address: Record<string, unknown>) => {
        await answer()
        return { ...address, id: 'addr-new', isDefaultBilling: false, isDefaultShipping: false }
      },
      remove: async () => undefined,
    },
    orders: {
      list: async () => ({ items: [], nextCursor: null }),
      get: async () => {
        throw new Error('No order')
      },
    },
  }
}

/** The reviews SDK the review form submits through (`client.adapter.reviews`), answering as `s.phase` says. */
function installReviews(client: Record<string, unknown>, s: State): void {
  client['adapter'] = {
    reviews: {
      getForProduct: async () => ({ items: [], nextCursor: null }),
      submit: async (review: Record<string, unknown>) => {
        if (s.phase === 'pending') await new Promise<never>(() => undefined)
        if (s.phase === 'failed') throw new Error('Refused by the AC-1 fake.')
        return {
          review: {
            ...review,
            id: 'rev-ac1',
            customerId: null,
            orderId: null,
            moderationStatus: 'pending',
            submittedAt: '2026-10-22T00:00:00.000Z',
            moderatedAt: null,
            moderatedBy: null,
          },
        }
      },
    },
  }
}

/** The checkout SDK the checkout drives: its setters keep what they are given; `submitPayment()` answers as `phase` says. */
function installCheckout(client: Record<string, unknown>, phase: Phase): void {
  const checkout = client['checkout'] as Record<string, unknown> & {
    setState(partial: Record<string, unknown>): void
  }
  const keep = (key: string) => (value: unknown) => checkout.setState({ [key]: value })
  Object.assign(checkout, {
    setEmail: keep('email'),
    setShippingAddress: keep('shippingAddress'),
    setBillingAddress: keep('billingAddress'),
    setShippingMethod: keep('shippingMethod'),
    markConfirmed: () => undefined,
    reset: () => undefined,
    submitPayment: () => {
      if (phase === 'pending') return new Promise<never>(() => undefined)
      if (phase === 'failed') {
        checkout.setState({ error: 'Refused by the AC-1 fake.', placedOrderNumber: null })
        return Promise.resolve(null)
      }
      return Promise.resolve({
        orderId: 'ord-ac1',
        orderNumber: 'NYM-AC1',
        paymentIntent: {
          id: 'pi_ac1',
          clientSecret: 'pi_ac1_secret',
          amountMinor: 1200,
          currency: 'GBP',
          status: 'succeeded',
        },
        currency: 'GBP',
        totalMinor: 1200,
        orderStatus: 'confirmed',
        payment: { status: 'succeeded' },
      })
    },
  })
}

/** Every element matching `selector` in `root` and in every open shadow root beneath it, outer roots first. */
function deepAll(root: ParentNode, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)]
  for (const node of root.querySelectorAll('*')) {
    if (node.shadowRoot) found.push(...deepAll(node.shadowRoot, selector))
  }
  return found
}

const FILL: Record<string, string> = {
  email: 'ada@example.test',
  password: 'CorrectHorse123!',
  tel: '+447700900000',
  number: '1',
}

/** Fills every field of the element's form with a valid value and submits it once (no form: nothing to submit). */
async function submitOnce(el: HTMLElement): Promise<void> {
  const root = el.shadowRoot
  if (root === null) return
  for (const field of deepAll(root, 'input, textarea, select')) {
    const input = field as HTMLInputElement
    if (input.disabled || ['hidden', 'checkbox', 'radio', 'submit', 'button'].includes(input.type))
      continue
    if (field.localName === 'select') {
      const options = [...(field as HTMLSelectElement).options].filter((o) => o.value !== '')
      if (options[0]) (field as HTMLSelectElement).value = options[0].value
    } else {
      input.value = FILL[input.type] ?? 'Ada'
    }
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    field.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  }
  const form = deepAll(root, 'form')[0] as HTMLFormElement | undefined
  form?.requestSubmit()
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await settled(el)
  }
}

function schemaOf(ctor: unknown): ElementSchema | undefined {
  return (ctor as { schema?: ElementSchema } | undefined)?.schema
}

/** Creates the element in `s`, connected, once its render has settled. */
async function mount(
  tag: Tag,
  s: State,
  onClient?: (client: Record<string, unknown>) => void,
): Promise<HTMLElement> {
  const client = setupMockClient() as unknown as Record<
    StoreName,
    { setState(partial: Record<string, unknown>): void }
  >
  onClient?.(client as unknown as Record<string, unknown>)
  installAccount(client as unknown as Record<string, unknown>, s)
  installReviews(client as unknown as Record<string, unknown>, s)
  installCheckout(client as unknown as Record<string, unknown>, s.placeOrder ?? 'succeeded')
  for (const [name, partial] of Object.entries(s.stores)) {
    client[name as StoreName].setState(partial)
  }
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(s.attrs)) el.setAttribute(name, value)
  for (const child of s.children?.() ?? []) el.appendChild(child)
  document.body.appendChild(el)
  await settled(el)
  for (const t of s.toasts) {
    ;(el as unknown as { show(message: string, type: ToastType): void }).show(t.message, t.type)
  }
  await settled(el)
  if (s.phase !== null) await submitOnce(el)
  if (s.walk !== undefined) await s.walk(el)
  return el
}

/** Counts the live subscriptions across every store of a mock client, from the moment it is installed. */
function liveSubscriptions(client: Record<string, unknown>): () => number {
  let live = 0
  for (const store of Object.values(client)) {
    const s = store as { subscribe?: (fn: () => void) => () => void } | null
    if (typeof s?.subscribe !== 'function') continue
    const subscribe = s.subscribe.bind(s)
    s.subscribe = (fn) => {
      const unsubscribe = subscribe(fn)
      live += 1
      let done = false
      return () => {
        if (!done) live -= 1
        done = true
        unsubscribe()
      }
    }
  }
  return () => live
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

const PHASES: Phase[] = ['pending', 'failed', 'succeeded']

const pageItem = fc.record({
  variantId: word,
  productId: word,
  productName: word,
  variantName: word,
  qty: fc.integer({ min: 1, max: 99 }),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
  imageUrl: fc.constantFrom('', 'https://example.test/line.jpg'),
})

const cardProduct = fc.record({
  id: word,
  slug: word,
  name: word,
  priceMinor: fc.option(fc.integer({ min: 0, max: 100_000 })),
  priceRange: fc.option(
    fc
      .tuple(fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 50_000 }))
      .map(([a, b]) => ({ minMinor: Math.min(a, b), maxMinor: Math.max(a, b) })),
  ),
  currency: fc.constantFrom('GBP', null),
  media: fc.constantFrom([], [{ url: 'https://example.test/card.jpg', alt: 'Card' }]),
})

function card(partial: Record<string, unknown> = {}) {
  return {
    id: 'p-mug',
    slug: 'mug',
    name: 'Mug',
    priceMinor: 1200,
    priceRange: null,
    currency: 'GBP',
    media: [],
    ...partial,
  }
}

const savedAddress = fc.record({
  id: word,
  firstName: word,
  lastName: word,
  addressLine1: word,
  addressLine2: fc.option(word, { nil: undefined }),
  city: word,
  region: word,
  postalCode: word,
  country: fc.constantFrom('GB', 'FR'),
  isDefaultShipping: fc.boolean(),
  isDefaultBilling: fc.boolean(),
})

const ADDRESS = {
  id: 'addr-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  addressLine1: '1 Analytical Row',
  addressLine2: 'Flat 2',
  city: 'London',
  region: 'Greater London',
  postalCode: 'E1 6AN',
  country: 'GB',
  isDefaultShipping: true,
  isDefaultBilling: false,
}

/** A form's states: as rendered, and submitted once with its call held, refused and answered. */
function formStates(base: Partial<State> = {}): State[] {
  return [state(base), ...PHASES.map((phase) => state({ ...base, phase }))]
}

const signedIn = { stores: { auth: { customer: CUSTOMER, isAuthenticated: true } } }

// ─── The checkout's steps, walked as a shopper walks them ───────────────────

/** Lit renders in microtasks, the address forms inside the checkout too; no animation frame passes here. */
async function settledDeep(el: HTMLElement): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await settled(el)
    const nested = el.shadowRoot === null ? [] : deepAll(el.shadowRoot, '*')
    await Promise.all(nested.map((node) => settled(node as HTMLElement)))
  }
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

function field(el: HTMLElement, testId: string): HTMLInputElement {
  const found = deepAll(el.shadowRoot ?? el, `[data-testid="${testId}"]`)[0]
  if (found === undefined) throw new Error(`no [data-testid="${testId}"] in ${el.localName}`)
  return found as HTMLInputElement
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

/** One press of a step's submit button, a frame after its step showed. */
async function press(el: HTMLElement, testId: string): Promise<void> {
  await nextFrame()
  field(el, testId).dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1 }),
  )
  await settledDeep(el)
}

const WALK_ADDRESS: Record<string, string> = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  addressLine1: '1 Analytical Row',
  addressLine2: '',
  city: 'London',
  region: 'Greater London',
  postalCode: 'E1 6AN',
  country: 'GB',
}

function fillAddress(el: HTMLElement, prefix: 'shipping' | 'billing'): void {
  for (const [name, value] of Object.entries(WALK_ADDRESS)) {
    typeInto(
      field(el, `${prefix}-${name}`),
      prefix === 'billing' && value !== '' ? `${value} B` : value,
    )
  }
}

type CheckoutStop = 'contact' | 'shipping' | 'payment' | 'place'

/** Walks the checkout to `stop`; billing differs when asked; `place` presses place-order once. */
function walkTo(stop: CheckoutStop, billingDiffers = false): (el: HTMLElement) => Promise<void> {
  return async (el) => {
    await settledDeep(el)
    if (stop === 'contact') return
    typeInto(field(el, 'contact-email'), 'ada@example.test')
    await press(el, 'contact-continue')
    if (stop === 'shipping') return
    fillAddress(el, 'shipping')
    await press(el, 'shipping-continue')
    if (billingDiffers) {
      field(el, 'billing-same').click()
      await settledDeep(el)
      fillAddress(el, 'billing')
    }
    if (stop === 'payment') return
    await press(el, 'place-order')
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await settledDeep(el)
    }
  }
}

/** The checkout's payment element, a `payment`-slotted child; `'null'` takes no payment, `'not json'` errors. */
const paymentChild = (client: string) => (): Node[] => {
  const pay = document.createElement(PAYMENT)
  pay.setAttribute('slot', 'payment')
  pay.setAttribute('client', client)
  return [pay]
}

/** Every state of the checkout's render, over a given cart. */
function checkoutStates(stores: State['stores'] = {}): State[] {
  const at = (partial: Partial<State>) =>
    state({ stores, children: paymentChild('null'), ...partial })
  return [
    at({}),
    at({ walk: walkTo('shipping') }),
    at({ walk: walkTo('payment') }),
    at({ walk: walkTo('payment', true) }),
    ...PHASES.map((placeOrder) => at({ walk: walkTo('place'), placeOrder })),
    at({ walk: walkTo('place', true), placeOrder: 'failed' }),
    at({ children: paymentChild('not json'), walk: walkTo('payment') }),
  ]
}

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
          product: productOf([[{ name: 'Size', value: 's' }], [{ name: 'Size', value: 'm' }]]),
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
          facets: [{ field: 'category', label: 'Category', values: [{ value: 'home', count: 3 }] }],
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
  'nymbal-cart-page': [
    state(),
    state({ stores: { cart: cartOf([], true) } }),
    state({
      stores: {
        cart: cartOf([
          {
            variantId: 'v1',
            productId: 'p1',
            productName: 'Mug',
            variantName: 'Blue',
            qty: 2,
            priceMinor: 1200,
            imageUrl: '',
          },
          {
            variantId: 'v2',
            productId: 'p2',
            productName: 'Scarf',
            variantName: '',
            qty: 1,
            priceMinor: 2500,
            imageUrl: 'https://example.test/scarf.jpg',
          },
        ]),
      },
    }),
  ],
  'nymbal-product-card': [
    state(),
    state({ attrs: { product: JSON.stringify(card()) } }),
    state({
      attrs: {
        product: JSON.stringify(
          card({ priceMinor: null, priceRange: { minMinor: 1000, maxMinor: 2000 } }),
        ),
      },
    }),
    state({
      attrs: {
        product: JSON.stringify(
          card({ media: [{ url: 'https://example.test/mug.jpg', alt: 'Mug' }] }),
        ),
      },
    }),
    state({
      attrs: {
        product: JSON.stringify(card({ priceMinor: null, priceRange: null, currency: null })),
      },
    }),
  ],
  'nymbal-search-results': [
    state(),
    state({ stores: { search: { query: 'mug', loading: true, results: [] } } }),
    state({ stores: { search: { query: 'zqxj', loading: false, results: [], total: 0 } } }),
    state({
      stores: {
        search: {
          query: 'mug',
          loading: false,
          results: [card(), card({ id: 'p-cup', slug: 'cup', name: 'Cup' })],
          total: 2,
          nextCursor: null,
        },
      },
    }),
    state({
      stores: {
        search: { query: 'mug', loading: false, results: [card()], total: 3, nextCursor: 'c2' },
      },
    }),
    state({
      stores: {
        search: { query: 'mug', loading: true, results: [card()], total: 3, nextCursor: 'c2' },
      },
    }),
  ],
  'nymbal-login-form': formStates(),
  'nymbal-register-form': formStates(),
  'nymbal-profile-form': formStates(signedIn),
  'nymbal-address-form': [state()],
  'nymbal-address-book': [
    state({ ...signedIn, addresses: [] }),
    state({
      ...signedIn,
      addresses: [ADDRESS, { ...ADDRESS, id: 'addr-2', isDefaultShipping: false }],
    }),
    state({ ...signedIn, addresses: 'fail' }),
    ...PHASES.map((phase) => state({ ...signedIn, addresses: [ADDRESS], phase })),
  ],
  'nymbal-checkout': [
    ...checkoutStates(),
    ...checkoutStates({
      cart: cartOf([
        { variantId: 'v1', productName: 'Mug', variantName: 'Blue', qty: 2, priceMinor: 1200 },
        { variantId: 'v2', productName: 'Scarf', variantName: '', qty: 1, priceMinor: 2500 },
      ]),
    }).slice(0, 1),
  ],
  // Catalogue and page elements
  'nymbal-product-grid': [
    state(),
    state({ attrs: { products: JSON.stringify([]) } }),
    state({
      attrs: {
        products: JSON.stringify([card(), card({ id: 'p-cup', slug: 'cup', name: 'Cup' })]),
        'has-more': '',
      },
    }),
    state({
      attrs: { source: 'product-list', products: JSON.stringify([card()]) },
      stores: {
        productList: {
          products: [card(), card({ id: 'p-cup', slug: 'cup', name: 'Cup' })],
          pagination: { cursor: 'c2', hasMore: true },
          loading: false,
        },
      },
    }),
    state({
      attrs: { source: 'product-list' },
      stores: { productList: { products: [], pagination: { cursor: null, hasMore: false } } },
    }),
  ],
  'nymbal-product-price': [
    state(),
    state({ attrs: { 'price-minor': '1200', currency: 'GBP' } }),
    state({ attrs: { 'price-minor': '1200', 'compare-at-minor': '1500', currency: 'GBP' } }),
    state({
      attrs: { 'product-id': 'p1', 'price-minor': '1200', currency: 'GBP' },
      stores: {
        product: { product: productOf([[]]), selectedVariant: productOf([[]]).variants[0] },
      },
    }),
  ],
  'nymbal-stock-badge': [
    state(),
    state({ attrs: { stock: '0' } }),
    state({ attrs: { stock: '3' } }),
    state({ attrs: { stock: '12' } }),
    state({
      attrs: { 'product-id': 'p1', stock: '0' },
      stores: {
        product: { product: productOf([[]]), selectedVariant: productOf([[]]).variants[0] },
      },
    }),
  ],
  'nymbal-breadcrumb': [
    state(),
    state({
      attrs: {
        items: JSON.stringify([
          { label: 'Home', href: '/' },
          { label: 'Products', href: '/products' },
          { label: 'Mug' },
        ]),
      },
    }),
  ],
  'nymbal-image-gallery': [
    state(),
    state({ attrs: { images: JSON.stringify([{ url: 'https://example.test/a.jpg', alt: 'A' }]) } }),
    state({
      attrs: {
        images: JSON.stringify([
          { url: 'https://example.test/a.jpg', alt: 'A' },
          { url: 'https://example.test/b.jpg', alt: 'B' },
          { url: 'https://example.test/c.jpg', alt: 'C' },
        ]),
      },
    }),
  ],
  'nymbal-site-header': [
    state(),
    state({
      attrs: {
        links: JSON.stringify([
          { label: 'Shop', href: '/products' },
          { label: 'Apparel', href: '/category/apparel' },
        ]),
        logo: 'Nymbal',
        'account-href': '/account',
      },
    }),
  ],
  'nymbal-site-footer': [
    state(),
    state({
      attrs: {
        columns: JSON.stringify([
          { heading: 'Shop', links: [{ label: 'All Products', href: '/products' }] },
          { heading: 'Account', links: [{ label: 'Login', href: '/account/login' }] },
        ]),
        year: '2026',
      },
    }),
  ],
  'nymbal-category-nav': [
    state(),
    state({
      attrs: {
        categories: JSON.stringify([
          {
            id: 'c1',
            parentId: null,
            name: 'Home',
            slug: 'home',
            description: 'For the home',
            position: 0,
            createdAt: '',
          },
          {
            id: 'c2',
            parentId: null,
            name: 'Books',
            slug: 'books',
            description: '',
            position: 1,
            createdAt: '',
          },
        ]),
      },
    }),
  ],
  'nymbal-review-list': [
    state(),
    state({ attrs: { reviews: JSON.stringify([]) } }),
    state({
      attrs: {
        reviews: JSON.stringify([
          {
            id: 'r1',
            productId: 'p1',
            rating: 4,
            title: 'Good',
            body: 'Solid mug.',
            submittedAt: '2026-10-22T00:00:00.000Z',
          },
          {
            id: 'r2',
            productId: 'p1',
            rating: 2,
            title: 'Meh',
            body: 'Chipped.',
            submittedAt: '2026-10-21T00:00:00.000Z',
          },
        ]),
      },
    }),
  ],
  'nymbal-review-form': formStates({ attrs: { 'product-id': 'p1' } }),
  'nymbal-order-summary': [
    state(),
    state({
      attrs: {
        items: JSON.stringify([
          { name: 'Mug', qty: 2, unitPriceMinor: 1200, lineTotalMinor: 2400 },
          { name: 'Scarf', qty: 1, unitPriceMinor: 2500, lineTotalMinor: 2500 },
        ]),
        'subtotal-minor': '4900',
        'discount-minor': '0',
        'shipping-minor': '500',
        'tax-minor': '0',
        'total-minor': '5400',
        currency: 'GBP',
      },
    }),
    state({
      attrs: {
        items: JSON.stringify([
          { name: 'Mug', qty: 1, unitPriceMinor: 1200, lineTotalMinor: 1200 },
        ]),
        'subtotal-minor': '1200',
        'discount-minor': '200',
        'shipping-minor': '0',
        'tax-minor': '100',
        'total-minor': '1100',
        currency: 'GBP',
      },
    }),
  ],
  'nymbal-order-timeline': [
    state(),
    state({
      attrs: {
        entries: JSON.stringify([
          { kind: 'placed', at: '2026-10-25T09:00:00.000Z' },
          { kind: 'paid', at: '2026-10-25T09:00:02.000Z' },
          { kind: 'shipped', at: '2026-10-26T14:30:00.000Z' },
        ]),
        'time-zone': 'Europe/London',
      },
    }),
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
          product: {
            product: variants === null ? null : productOf(variants),
            selectedVariant: null,
          },
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
      fc.record({
        message: word,
        type: fc.constantFrom<ToastType>('success', 'error', 'warning', 'info'),
      }),
      { maxLength: 3 },
    )
    .map((toasts) => state({ toasts })),
  [PAYMENT]: fc
    .constantFrom(null, 'not json', JSON.stringify({ driver: 'no-such-driver', options: {} }))
    .map((client) => state({ attrs: client === null ? {} : { client } })),
  'nymbal-sort-dropdown': fc
    .record({ keys: fc.subarray(SORT_KEYS), value: fc.constantFrom(...SORT_KEYS) })
    .map(({ keys, value }) => state({ attrs: { 'sort-keys': JSON.stringify(keys), value } })),
  'nymbal-cart-page': fc
    .record({
      items: fc.uniqueArray(pageItem, { maxLength: 5, selector: (i) => i.variantId }),
      loading: fc.boolean(),
    })
    .map(({ items, loading }) => state({ stores: { cart: cartOf(items, loading) } })),
  'nymbal-product-card': cardProduct.map((p) => state({ attrs: { product: JSON.stringify(p) } })),
  'nymbal-search-results': fc
    .record({
      query: fc.oneof(fc.constant(''), word),
      loading: fc.boolean(),
      results: fc.uniqueArray(cardProduct, { maxLength: 4, selector: (p) => p.slug }),
      nextCursor: fc.option(word),
      total: fc.integer({ min: 0, max: 50 }),
    })
    .map((search) => state({ stores: { search } })),
  'nymbal-login-form': fc.option(fc.constantFrom(...PHASES)).map((phase) => state({ phase })),
  'nymbal-register-form': fc.option(fc.constantFrom(...PHASES)).map((phase) => state({ phase })),
  'nymbal-profile-form': fc
    .option(fc.constantFrom(...PHASES))
    .map((phase) => state({ ...signedIn, phase })),
  'nymbal-address-form': fc.constant(state()),
  'nymbal-address-book': fc
    .record({
      addresses: fc.oneof(
        fc.constant<'fail'>('fail'),
        fc.uniqueArray(savedAddress, { maxLength: 3, selector: (a) => a.id }),
      ),
      phase: fc.option(fc.constantFrom(...PHASES)),
    })
    .map(({ addresses, phase }) => state({ ...signedIn, addresses, phase })),
  'nymbal-checkout': fc
    .record({
      items: fc.array(cartItem, { maxLength: 3 }),
      at: fc.nat({ max: checkoutStates().length - 1 }),
    })
    .map(({ items, at }) => checkoutStates({ cart: cartOf(items) })[at]!),
  // Catalogue and page elements
  'nymbal-product-grid': fc
    .record({
      products: fc.uniqueArray(cardProduct, { maxLength: 6, selector: (p) => p.slug }),
      hasMore: fc.boolean(),
      source: fc.boolean(),
      stored: fc.uniqueArray(cardProduct, { maxLength: 6, selector: (p) => p.slug }),
      storeHasMore: fc.boolean(),
      loading: fc.boolean(),
    })
    .map(({ products, hasMore, source, stored, storeHasMore, loading }) =>
      state({
        attrs: {
          products: JSON.stringify(products),
          ...(hasMore && { 'has-more': '' }),
          ...(source && { source: 'product-list' }),
        },
        stores: {
          productList: {
            products: stored,
            pagination: { cursor: storeHasMore ? 'c2' : null, hasMore: storeHasMore },
            loading,
          },
        },
      }),
    ),
  'nymbal-product-price': fc
    .record({
      price: fc.option(fc.integer({ min: 0, max: 100_000 })),
      compareAt: fc.option(fc.integer({ min: 0, max: 100_000 })),
      same: fc.boolean(),
      variants: fc.array(fc.array(option, { maxLength: 2 }), { minLength: 1, maxLength: 3 }),
      loading: fc.boolean(),
    })
    .map(({ price, compareAt, same, variants, loading }) => {
      const product = productOf(variants)
      return state({
        attrs: {
          'product-id': same ? product.id : 'other',
          currency: 'GBP',
          ...(price !== null && { 'price-minor': String(price) }),
          ...(compareAt !== null && { 'compare-at-minor': String(compareAt) }),
        },
        stores: { product: { product, selectedVariant: product.variants[0], loading } },
      })
    }),
  'nymbal-stock-badge': fc
    .record({
      stock: fc.option(fc.integer({ min: -20, max: 50 })),
      same: fc.boolean(),
      loading: fc.boolean(),
    })
    .map(({ stock, same, loading }) => {
      const product = productOf([[]])
      return state({
        attrs: {
          'product-id': same ? product.id : 'other',
          ...(stock !== null && { stock: String(stock) }),
        },
        stores: { product: { product, selectedVariant: product.variants[0], loading } },
      })
    }),
  'nymbal-breadcrumb': fc
    .array(
      fc.record({
        label: word,
        href: fc.option(
          word.map((w) => `/${w}`),
          { nil: undefined },
        ),
      }),
      {
        maxLength: 4,
      },
    )
    .map((items) => state({ attrs: { items: JSON.stringify(items) } })),
  'nymbal-image-gallery': fc
    .uniqueArray(fc.record({ url: word.map((w) => `https://example.test/${w}.jpg`), alt: word }), {
      maxLength: 4,
      selector: (i) => i.url,
    })
    .map((images) => state({ attrs: { images: JSON.stringify(images) } })),
  'nymbal-site-header': fc
    .record({
      links: fc.uniqueArray(fc.record({ label: word, href: word.map((w) => `/${w}`) }), {
        maxLength: 5,
        selector: (l) => l.href,
      }),
      logo: fc.option(word),
      account: fc.option(fc.constant('/account')),
    })
    .map(({ links, logo, account }) =>
      state({
        attrs: {
          links: JSON.stringify(links),
          ...(logo !== null && { logo }),
          ...(account !== null && { 'account-href': account }),
        },
      }),
    ),
  'nymbal-site-footer': fc
    .record({
      columns: fc.array(
        fc.record({
          heading: word,
          links: fc.array(fc.record({ label: word, href: word.map((w) => `/${w}`) }), {
            maxLength: 4,
          }),
        }),
        { maxLength: 4 },
      ),
      year: fc.option(fc.integer({ min: 2000, max: 2100 })),
    })
    .map(({ columns, year }) =>
      state({
        attrs: { columns: JSON.stringify(columns), ...(year !== null && { year: String(year) }) },
      }),
    ),
  'nymbal-category-nav': fc
    .uniqueArray(
      fc.record({
        id: word,
        parentId: fc.constant(null),
        name: word,
        slug: word,
        description: fc.constantFrom('', 'A category'),
        position: fc.nat({ max: 9 }),
        createdAt: fc.constant(''),
      }),
      { maxLength: 5, selector: (c) => c.slug },
    )
    .map((categories) => state({ attrs: { categories: JSON.stringify(categories) } })),
  'nymbal-review-list': fc
    .uniqueArray(
      fc.record({
        id: word,
        productId: fc.constant('p1'),
        rating: fc.integer({ min: 1, max: 5 }),
        title: word,
        body: word,
        submittedAt: fc.constant('2026-10-22T00:00:00.000Z'),
      }),
      { maxLength: 4, selector: (r) => r.id },
    )
    .map((reviews) => state({ attrs: { reviews: JSON.stringify(reviews) } })),
  'nymbal-review-form': fc
    .option(fc.constantFrom(...PHASES))
    .map((phase) => state({ attrs: { 'product-id': 'p1' }, phase })),
  'nymbal-order-summary': fc
    .record({
      lines: fc.array(
        fc.record({
          name: word,
          qty: fc.integer({ min: 1, max: 9 }),
          unitPriceMinor: fc.integer({ min: 0, max: 100_000 }),
        }),
        { maxLength: 4 },
      ),
      discount: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5_000 })),
      shipping: fc.integer({ min: 0, max: 2_000 }),
      tax: fc.integer({ min: 0, max: 2_000 }),
    })
    .map(({ lines, discount, shipping, tax }) => {
      const items = lines.map((l) => ({ ...l, lineTotalMinor: l.qty * l.unitPriceMinor }))
      const subtotal = items.reduce((n, l) => n + l.lineTotalMinor, 0)
      return state({
        attrs: {
          items: JSON.stringify(items),
          'subtotal-minor': String(subtotal),
          'discount-minor': String(discount),
          'shipping-minor': String(shipping),
          'tax-minor': String(tax),
          'total-minor': String(subtotal - discount + shipping + tax),
          currency: 'GBP',
        },
      })
    }),
  'nymbal-order-timeline': fc
    .record({
      entries: timelineEntries(),
      zone: fc.option(fc.constantFrom('UTC', 'Europe/London', 'Asia/Kolkata', 'Not/AZone'), {
        nil: undefined,
      }),
    })
    .map(({ entries, zone }) =>
      state({
        attrs: {
          entries: JSON.stringify(entries),
          ...(zone !== undefined && { 'time-zone': zone }),
        },
      }),
    ),
}

describe('AC-1: elements are Lit, in an open shadow root, with the parts their schema lists', () => {
  it('AC-1: every element registerComponents() defines is a LitElement, and its schema.tag is the name it is defined under', async () => {
    // Lit is a dependency of the package; imported at run time so the other cases still report their own red.
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

  it('every element that subscribes to a store when it connects drops each subscription when it is removed: live subscriptions after removal equal those before connection', async () => {
    const subscribing: string[] = []
    for (const tag of TAGS) {
      let live: () => number = () => 0
      let before = 0
      const el = await mount(tag, state(), (client) => {
        live = liveSubscriptions(client)
        before = live()
      })
      if (live() > before) subscribing.push(tag)
      el.remove()
      expect(live(), `${tag}: live subscriptions after removal`).toBe(before)
      document.body.innerHTML = ''
    }
    // The elements that render a store's state; a refactor that stops one subscribing would make this case vacuous for it.
    expect(subscribing).toEqual(
      expect.arrayContaining([
        'nymbal-add-to-cart',
        'nymbal-cart-drawer',
        'nymbal-mini-cart',
        'nymbal-search-bar',
        'nymbal-product-filter',
      ]),
    )
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

// The names the templates reach the views by: the React wrapper and its handler props are generated from these, so a
// wrapper named or wired differently leaves Next's page calling a prop that never fires (`onSignedIn` is how Next
// navigates after sign-in).
const INTERFACE: Array<{
  tag: Tag
  reactName: string
  events: Array<{ name: string; prop: string }>
  /** Pinned attributes, in any order; a type left out is the element's own choice (none is pinned). */
  attributes?: Array<{ name: string; type?: string }>
}> = [
  { tag: 'nymbal-cart-page', reactName: 'CartPage', events: [] },
  {
    tag: 'nymbal-product-card',
    reactName: 'ProductCard',
    events: [],
    // The card takes `eager`.
    attributes: [
      { name: 'product', type: 'json' },
      { name: 'eager', type: 'boolean' },
    ],
  },
  { tag: 'nymbal-search-results', reactName: 'SearchResults', events: [] },
  {
    tag: 'nymbal-login-form',
    reactName: 'LoginForm',
    events: [{ name: 'nymbal:auth:signed-in', prop: 'onSignedIn' }],
    attributes: [],
  },
  {
    tag: 'nymbal-register-form',
    reactName: 'RegisterForm',
    events: [{ name: 'nymbal:auth:signed-in', prop: 'onSignedIn' }],
    attributes: [],
  },
  {
    tag: 'nymbal-profile-form',
    reactName: 'ProfileForm',
    events: [{ name: 'nymbal:profile:saved', prop: 'onSaved' }],
  },
  { tag: 'nymbal-address-form', reactName: 'AddressForm', events: [] },
  {
    tag: 'nymbal-address-book',
    reactName: 'AddressBook',
    events: [{ name: 'nymbal:address-book:changed', prop: 'onChanged' }],
  },
  // Catalogue and page elements
  {
    tag: 'nymbal-product-grid',
    reactName: 'ProductGrid',
    events: [],
    attributes: [
      { name: 'products', type: 'json' },
      { name: 'source', type: 'string' },
      { name: 'has-more', type: 'boolean' },
      { name: 'lazy', type: 'boolean' },
    ],
  },
  {
    tag: 'nymbal-product-price',
    reactName: 'ProductPrice',
    events: [],
    attributes: [
      { name: 'product-id', type: 'string' },
      { name: 'price-minor', type: 'number' },
      { name: 'currency', type: 'string' },
      { name: 'compare-at-minor', type: 'number' },
    ],
  },
  {
    tag: 'nymbal-stock-badge',
    reactName: 'StockBadge',
    events: [],
    attributes: [
      { name: 'product-id', type: 'string' },
      { name: 'stock', type: 'number' },
    ],
  },
  {
    tag: 'nymbal-breadcrumb',
    reactName: 'Breadcrumb',
    events: [],
    attributes: [{ name: 'items', type: 'json' }],
  },
  {
    tag: 'nymbal-image-gallery',
    reactName: 'ImageGallery',
    events: [],
    attributes: [{ name: 'images', type: 'json' }],
  },
  {
    tag: 'nymbal-site-header',
    reactName: 'SiteHeader',
    events: [],
    attributes: [
      { name: 'links', type: 'json' },
      { name: 'logo', type: 'string' },
      { name: 'account-href', type: 'string' },
    ],
  },
  {
    tag: 'nymbal-site-footer',
    reactName: 'SiteFooter',
    events: [],
    attributes: [{ name: 'columns', type: 'json' }, { name: 'year' }],
  },
  {
    tag: 'nymbal-category-nav',
    reactName: 'CategoryNav',
    events: [],
    attributes: [{ name: 'categories', type: 'json' }],
  },
  {
    tag: 'nymbal-review-list',
    reactName: 'ReviewList',
    events: [],
    attributes: [{ name: 'reviews', type: 'json' }],
  },
  {
    tag: 'nymbal-review-form',
    reactName: 'ReviewForm',
    events: [{ name: 'nymbal:review:submitted', prop: 'onSubmitted' }],
    attributes: [{ name: 'product-id', type: 'string' }],
  },
  {
    tag: 'nymbal-order-summary',
    reactName: 'OrderSummary',
    events: [],
    attributes: [
      { name: 'items', type: 'json' },
      { name: 'subtotal-minor', type: 'number' },
      { name: 'discount-minor', type: 'number' },
      { name: 'shipping-minor', type: 'number' },
      { name: 'tax-minor', type: 'number' },
      { name: 'total-minor', type: 'number' },
      { name: 'currency', type: 'string' },
    ],
  },
  {
    tag: 'nymbal-order-timeline',
    reactName: 'OrderTimeline',
    events: [],
    attributes: [
      { name: 'entries', type: 'json' },
      { name: 'time-zone', type: 'string' },
    ],
  },
]

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)

describe('AC-1: the moved views carry the interface the templates call them by', () => {
  it('AC-1: each new element’s schema names its React wrapper, its events with their handler props, and its attributes', () => {
    for (const want of INTERFACE) {
      const schema = schemaOf(customElements.get(want.tag))
      expect(schema, `${want.tag} is defined with a static schema`).toBeDefined()
      expect(schema?.reactName, `${want.tag}: reactName`).toBe(want.reactName)
      for (const event of want.events) {
        expect(schema?.events ?? [], `${want.tag}: events`).toContainEqual(
          expect.objectContaining(event),
        )
      }
      // Where the interface lists attributes they are all of them, in any order; a type it leaves out is not pinned.
      const declared = (schema?.attributes ?? [])
        .map(({ name, type }) => ({ name, type }))
        .sort(byName)
      const wanted = want.attributes
        ?.map((a) => ({
          name: a.name,
          type: a.type ?? declared.find((d) => d.name === a.name)?.type,
        }))
        .sort(byName)
      expect(
        want.attributes === undefined ? undefined : declared,
        `${want.tag}: attributes`,
      ).toEqual(wanted)
    }
  })
})

// AC-1: the checkout's own interface (its React wrapper `Checkout` takes `onPlaced` and passes `PaymentElement`
// through as a child), its address blocks are `nymbal-address-form` in its own shadow root, each in the form its step
// submits (Enter in a field submits `closest('form')`, which does not cross a shadow boundary), and its summary is
// built as the cart page's is, with names as text.
describe('AC-1: nymbal-checkout meets the foundation', () => {
  it('AC-1: nymbal-checkout’s schema: reactName Checkout, one attribute (cart, json), nymbal:checkout:placed as onPlaced with { orderNumber: string; orderKey?: string }, a payment slot, children passed through', () => {
    const schema = schemaOf(customElements.get('nymbal-checkout'))
    expect(schema, 'nymbal-checkout is defined with a static schema').toBeDefined()
    expect(schema?.reactName).toBe('Checkout')
    expect(schema?.attributes).toEqual([{ name: 'cart', prop: 'cart', type: 'json' }])
    expect(schema?.events).toContainEqual({
      name: 'nymbal:checkout:placed',
      prop: 'onPlaced',
      detail: '{ orderNumber: string; orderKey?: string }',
    })
    expect(schema?.slots).toContain('payment')
    expect(schema?.children).toBe(true)
  })

  it('AC-1: its shipping and billing blocks are nymbal-address-form elements with id-prefix shipping and billing in its own shadow root, each inside the form whose submit button ends its step', async () => {
    const el = await mount('nymbal-checkout', checkoutStates()[3]!)
    const root = el.shadowRoot
    expect(root, 'nymbal-checkout renders in an open shadow root').not.toBeNull()
    const blocks = [...root!.querySelectorAll('nymbal-address-form')]
    expect(blocks.map((b) => b.getAttribute('id-prefix')).sort()).toEqual(['billing', 'shipping'])
    for (const block of blocks) {
      const prefix = block.getAttribute('id-prefix')!
      expect(
        block.shadowRoot?.querySelector(`[data-testid="${prefix}-firstName"]`),
        `${prefix}-firstName is the address form’s own field`,
      ).not.toBeNull()
      const submit = root!.querySelector(
        `[data-testid="${prefix === 'shipping' ? 'shipping-continue' : 'place-order'}"]`,
      )
      expect(submit, `the ${prefix} step’s submit button`).not.toBeNull()
      // happy-dom hands out a form as a proxy or as itself depending on the path, so the relation is containment.
      expect(
        block.closest('form')?.contains(submit) ?? false,
        `the ${prefix} block sits in the form that holds its step’s submit button`,
      ).toBe(true)
    }
  })

  it('AC-1: property: the summary (checkout-summary) shows each cart line’s name as text, never as markup, and cart-subtotal shows the cart’s subtotalMinor', async () => {
    const money = (minor: number) =>
      new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(cartItem, { minLength: 1, maxLength: 4, selector: (i) => i.variantId }),
        fc.integer({ min: 0, max: 500_000 }),
        async (lines, subtotalMinor) => {
          document.body.innerHTML = ''
          const items = lines.map((line) => ({
            ...line,
            productName: `<b>${line.productName}</b>`,
          }))
          const el = await mount(
            'nymbal-checkout',
            state({
              children: paymentChild('null'),
              stores: { cart: { ...cartOf(items), subtotalMinor } },
            }),
          )
          const summary = deepAll(el.shadowRoot ?? el, '[data-testid="checkout-summary"]')[0]
          expect(summary, 'checkout-summary inside nymbal-checkout').toBeDefined()
          for (const item of items) expect(summary!.textContent).toContain(item.productName)
          expect(summary!.querySelectorAll('b'), 'a name rendered as markup').toHaveLength(0)
          const subtotal = deepAll(summary!, '[data-testid="cart-subtotal"]')[0]
          expect(subtotal?.textContent ?? '').toContain(money(subtotalMinor))
        },
      ),
      { numRuns: 25 },
    )
  })
})

// AC-1: what the per-element conventions add for the catalogue and page elements. Each styles its parts on the
// `--nymbal-*` tokens (a project restyles it from its tokens file); each has the `src/elements/<tag>.ts` entry a page
// and a generated wrapper import (per-page defines), with the hydrate support as its first import so it evaluates
// before lit; the review form fires `nymbal:review:submitted` with `{ reviewId: string }`; the header places the
// page's search bar and mini-cart through its `search` and `cart` slots.
const CATALOGUE_TAGS = TAGS.slice(TAGS.indexOf('nymbal-product-grid'))
const HERE = dirname(fileURLToPath(import.meta.url))

describe('AC-1: the twelve elements meet the element conventions', () => {
  it('AC-1: each of the twelve styles itself with var(--nymbal-*) tokens', () => {
    expect(CATALOGUE_TAGS).toHaveLength(12)
    for (const tag of CATALOGUE_TAGS) {
      const ctor = customElements.get(tag) as
        | (CustomElementConstructor & { elementStyles?: Array<{ cssText?: string }> })
        | undefined
      expect(ctor, `${tag} is defined`).toBeDefined()
      const css = (ctor?.elementStyles ?? []).map((s) => s.cssText ?? '').join('\n')
      expect(
        css.match(/var\(--nymbal-[a-z0-9-]+/g)?.length ?? 0,
        `${tag}: var(--nymbal-*) uses`,
      ).toBeGreaterThan(0)
    }
  })

  it('AC-1: every element has src/elements/<tag>.ts, whose first import is the hydrate support and which exports the class defined under the tag', async () => {
    for (const tag of TAGS) {
      let source = ''
      try {
        // A path, not a URL: happy-dom's URL global is not the one node:fs accepts.
        source = readFileSync(join(HERE, 'elements', `${tag}.ts`), 'utf8')
      } catch {
        source = ''
      }
      expect(source, `src/elements/${tag}.ts`).not.toBe('')
      // The first statement, comments aside, is the side-effect import of the hydrate support.
      const firstStatement = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '' && !line.startsWith('//'))
      expect(firstStatement, `${tag}: its first statement`).toMatch(
        /^import\s+['"]\.\.\/hydrate-support\.js['"]/,
      )
      const entry = (await import(/* @vite-ignore */ `./elements/${tag}.js`)) as Record<
        string,
        unknown
      >
      const exported = Object.values(entry).filter((v) => schemaOf(v)?.tag === tag)
      expect(exported, `${tag}: the class its entry exports`).toEqual([customElements.get(tag)])
    }
  })

  it('AC-1: nymbal-review-form fires nymbal:review:submitted as onSubmitted with { reviewId: string }; nymbal-site-header has the search and cart slots', () => {
    const form = schemaOf(customElements.get('nymbal-review-form'))
    expect(form, 'nymbal-review-form is defined with a static schema').toBeDefined()
    expect(form?.events).toContainEqual({
      name: 'nymbal:review:submitted',
      prop: 'onSubmitted',
      detail: '{ reviewId: string }',
    })
    const header = schemaOf(customElements.get('nymbal-site-header'))
    expect(header, 'nymbal-site-header is defined with a static schema').toBeDefined()
    expect([...(header?.slots ?? [])].sort()).toEqual(expect.arrayContaining(['cart', 'search']))
  })

  it('AC-1: property: nymbal-site-header places light-DOM children carrying slot="search" and slot="cart" in its search and cart slots', async () => {
    expect(customElements.get('nymbal-site-header'), 'nymbal-site-header is defined').toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ label: word, href: word.map((w) => `/${w}`) }), { maxLength: 4 }),
        async (links) => {
          document.body.innerHTML = ''
          const search = document.createElement('span')
          search.setAttribute('slot', 'search')
          const cart = document.createElement('span')
          cart.setAttribute('slot', 'cart')
          const el = await mount(
            'nymbal-site-header',
            state({ attrs: { links: JSON.stringify(links) }, children: () => [search, cart] }),
          )
          // What each named slot holds (happy-dom has `assignedElements()`, not `assignedSlot`).
          const holds = (name: string): Element[] =>
            [...(el.shadowRoot?.querySelectorAll(`slot[name="${name}"]`) ?? [])].flatMap((s) =>
              (s as HTMLSlotElement).assignedElements(),
            )
          expect({ search: holds('search'), cart: holds('cart') }).toEqual({
            search: [search],
            cart: [cart],
          })
        },
      ),
      { numRuns: 10 },
    )
  })
})
