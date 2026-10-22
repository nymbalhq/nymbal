import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NymbalClient } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// P2-15 AC-2: `nymbal-cart-page` is the cart view both templates render, and it agrees with the cart store: one
// `cart-item-<variantId>` per line in store order, each with its name (as text), its price each and its quantity; the
// summary shows the state's `subtotalMinor` (decision 2: the API's, not a sum the element computes, which Astro's
// `cart-page.ts:23` does today); zero lines is the empty state; remove and a quantity step reach the store once.
// Kills: lines drifting from the store, a client-side subtotal, markup injected from a product name.

const TAG = 'nymbal-cart-page'

// Both locales a store renders in format these two the same, so the expected text does not hang on the host locale.
const CURRENCIES = ['GBP', 'EUR'] as const

function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
}

interface Line {
  variantId: string
  productId: string
  productName: string
  variantName: string
  priceMinor: number
  qty: number
  imageUrl: string
}

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

function setCart(state: Record<string, unknown>): void {
  ;(client.cart as unknown as { setState(p: object): void }).setState(state)
}

async function mount(): Promise<HTMLElement> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  const el = document.createElement(TAG)
  document.body.appendChild(el)
  await settled(el)
  return el
}

const testIdOf = (node: Element): string => node.getAttribute('data-testid') ?? ''

function lines(root: ShadowRoot): Element[] {
  return [...root.querySelectorAll('[data-testid^="cart-item-"]')]
}

/** The quantity the line's `nymbal-quantity-selector` shows, once it has rendered. */
async function shownQty(line: Element): Promise<string | undefined> {
  const selector = line.querySelector('nymbal-quantity-selector')
  if (selector === null) return undefined
  await settled(selector)
  return selector.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="qty-input"]')?.value
}

const MARKUP_NAMES = ['<b data-injected>Mug</b>', '<img src="x" data-injected onerror="alert(1)">']

const line = fc.record({
  variantId: fc.stringMatching(/^v[a-z0-9]{1,8}$/),
  productId: fc.stringMatching(/^p[a-z0-9]{1,8}$/),
  productName: fc.oneof(fc.stringMatching(/^[A-Z][a-z]{1,10}$/), fc.constantFrom(...MARKUP_NAMES)),
  variantName: fc.constantFrom('', 'Blue', 'Large'),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
  qty: fc.integer({ min: 1, max: 99 }),
  imageUrl: fc.constantFrom('', 'https://example.test/line.jpg'),
})

const linesOf = (min: number) =>
  fc.uniqueArray(line, { minLength: min, maxLength: 5, selector: (l) => l.variantId })

const sum = (items: Line[]): number => items.reduce((n, i) => n + i.priceMinor * i.qty, 0)

function cartState(items: Line[], currency: string, subtotalMinor = sum(items)) {
  return {
    items,
    subtotalMinor,
    currency,
    itemCount: items.reduce((n, i) => n + i.qty, 0),
    loading: false,
    error: null,
  }
}

describe('nymbal-cart-page agrees with the cart store', () => {
  it('AC-2: property: one cart-item-<variantId> per store line in store order, each showing its name as text, its price each and its quantity', async () => {
    await fc.assert(
      fc.asyncProperty(linesOf(0), fc.constantFrom(...CURRENCIES), async (items, currency) => {
        document.body.innerHTML = ''
        client = setupMockClient()
        setCart(cartState(items, currency))
        const root = shadow(await mount())

        expect(lines(root).map(testIdOf)).toEqual(items.map((i) => `cart-item-${i.variantId}`))
        for (const [i, item] of items.entries()) {
          const shown = lines(root)[i]!
          expect(shown.textContent, `line ${i}: name`).toContain(item.productName)
          // The price-each part alone: the whole line also holds its total, and £11.00 contains £1.00.
          const each = shown.querySelector('[part~="item-price"]')
          expect(each?.textContent?.replace(/\s+/g, ' ').trim(), `line ${i}: price each`).toBe(
            `${formatPrice(item.priceMinor, currency)} each`,
          )
          expect(await shownQty(shown), `line ${i}: quantity`).toBe(String(item.qty))
        }
        // A name is text: none of the markup a name carries became an element.
        expect(root.querySelectorAll('[data-injected]')).toHaveLength(0)
      }),
      { numRuns: 60 },
    )
  })

  it('AC-2: property: the summary shows the state’s subtotalMinor, not the Σ priceMinor × qty the element could compute', async () => {
    await fc.assert(
      fc.asyncProperty(
        linesOf(1),
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (items, currency, gap) => {
          document.body.innerHTML = ''
          client = setupMockClient()
          // The API's subtotal differs from the lines' sum (a discount, a rounding, a price the cart repriced).
          const subtotalMinor = sum(items) + gap
          setCart(cartState(items, currency, subtotalMinor))
          const root = shadow(await mount())

          const summary = root.querySelector('[data-testid="cart-summary"]')
          expect(summary, 'cart-summary renders while the cart has lines').not.toBeNull()
          expect(summary!.textContent).toContain(formatPrice(subtotalMinor, currency))
          expect(summary!.textContent).not.toContain(formatPrice(sum(items), currency))
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-2: a cart that goes from lines to none shows continue-shopping and neither cart-summary nor a line', async () => {
    const items: Line[] = [
      {
        variantId: 'v1',
        productId: 'p1',
        productName: 'Mug',
        variantName: 'Blue',
        priceMinor: 1200,
        qty: 2,
        imageUrl: '',
      },
    ]
    setCart(cartState(items, 'GBP'))
    const el = await mount()
    const root = shadow(el)
    expect(lines(root)).toHaveLength(items.length)
    expect(root.querySelector('[data-testid="continue-shopping"]')).toBeNull()

    setCart(cartState([], 'GBP'))
    await settled(el)
    const after = client.cart.getState().items
    expect(lines(root)).toHaveLength(after.length)
    expect(root.querySelector('[data-testid="cart-summary"]')).toBeNull()
    expect(root.querySelector('[data-testid="continue-shopping"]')).not.toBeNull()
  })

  it('AC-2: property: cart-remove-<id> calls removeItem(id) once, and a quantity step on a line calls updateQuantity(id, qty ± 1) once', async () => {
    await fc.assert(
      fc.asyncProperty(
        linesOf(1).chain((items) =>
          fc.record({
            items: fc.constant(items),
            removed: fc.nat({ max: items.length - 1 }),
            stepped: fc.nat({ max: items.length - 1 }),
          }),
        ),
        async ({ items, removed, stepped }) => {
          document.body.innerHTML = ''
          client = setupMockClient()
          setCart(cartState(items, 'GBP'))
          const removeItem = vi.fn(async () => undefined)
          const updateQuantity = vi.fn(async () => undefined)
          Object.assign(client.cart, { removeItem, updateQuantity })
          const root = shadow(await mount())

          const target = items[removed]!
          const remove = root.querySelector<HTMLElement>(
            `[data-testid="cart-remove-${target.variantId}"]`,
          )
          expect(remove, `cart-remove-${target.variantId}`).not.toBeNull()
          remove!.click()
          expect(removeItem).toHaveBeenCalledTimes(1)
          expect(removeItem).toHaveBeenCalledWith(target.variantId)
          expect(updateQuantity).not.toHaveBeenCalled()

          const line = items[stepped]!
          const selector = lines(root)[stepped]!.querySelector('nymbal-quantity-selector')
          expect(selector, `line ${stepped} has a nymbal-quantity-selector`).not.toBeNull()
          await settled(selector!)
          const up = line.qty < 99
          selector!
            .shadowRoot!.querySelector<HTMLElement>(
              `[data-testid="${up ? 'qty-increment' : 'qty-decrement'}"]`,
            )!
            .click()
          expect(updateQuantity).toHaveBeenCalledTimes(1)
          expect(updateQuantity).toHaveBeenCalledWith(line.variantId, line.qty + (up ? 1 : -1))
          expect(removeItem).toHaveBeenCalledTimes(1)
        },
      ),
      { numRuns: 40 },
    )
  })
})
