import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import type { CartCodeStatus, CartItem, ShopperCart } from '@nymbalhq/types'
import { NymbalApiError } from '../adapter/fetch-client.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { createCartStore } from './cart-store.js'

// The cart store keeps what the API last said of the cart: its lines and sums, the totals it comes to and the
// engine's word on each code, on every path including clear; a refused code call says why and keeps the rest.

const money = fc.integer({ min: 0, max: 100_000 })

const cartLine: fc.Arbitrary<CartItem> = fc.record({
  variantId: fc.stringMatching(/^v-[a-z0-9]{1,6}$/),
  productId: fc.stringMatching(/^p-[a-z0-9]{1,6}$/),
  productName: fc.stringMatching(/^[A-Z][a-z]{1,8}$/),
  variantName: fc.constantFrom('', 'Blue', 'Large'),
  priceMinor: money,
  qty: fc.integer({ min: 1, max: 99 }),
  imageUrl: fc.constant(''),
})

const codeStatus: fc.Arbitrary<CartCodeStatus> = fc.oneof(
  fc.record({
    code: fc.stringMatching(/^[A-Z0-9]{1,8}$/),
    status: fc.constant('accepted' as const),
  }),
  fc.record({
    code: fc.stringMatching(/^[A-Z0-9]{1,8}$/),
    status: fc.constant('pending' as const),
  }),
  fc.record({
    code: fc.stringMatching(/^[A-Z0-9]{1,8}$/),
    status: fc.constant('rejected' as const),
    reason: fc.constantFrom('expired', 'unknown', 'below_minimum'),
  }),
)

/** A cart answer as the cart routes give it; its money adds up as the server's does. */
const answer: fc.Arbitrary<ShopperCart> = fc
  .record({
    items: fc.uniqueArray(cartLine, { maxLength: 4, selector: (l) => l.variantId }),
    currency: fc.constantFrom('GBP', 'EUR', 'USD'),
    discountShare: fc.integer({ min: 0, max: 100 }),
    codes: fc.array(codeStatus, { maxLength: 5 }),
    unavailable: fc.boolean(),
    stamp: fc.nat(),
  })
  .map(({ items, currency, discountShare, codes, unavailable, stamp }) => {
    const subtotalMinor = items.reduce((sum, l) => sum + l.priceMinor * l.qty, 0)
    const discountTotalMinor = Math.floor((subtotalMinor * discountShare) / 100)
    return {
      token: `cart-${stamp}`,
      customerId: null,
      items,
      subtotalMinor,
      currency,
      source: 'storefront',
      expiresAt: '2026-12-21T00:00:00.000Z',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
      totals: {
        currency,
        subtotalMinor,
        discountTotalMinor,
        shippingTotalMinor: 0,
        shippingDiscountMinor: 0,
        taxTotalMinor: 0,
        totalMinor: subtotalMinor - discountTotalMinor,
        pricesIncludeTax: false,
        lines: [],
        applied: [],
      },
      promotions: { codes, unavailable },
    } as ShopperCart
  })

type Op =
  | { kind: 'addItem'; variantId: string; qty: number }
  | { kind: 'updateQuantity'; variantId: string; qty: number }
  | { kind: 'removeItem'; variantId: string }
  | { kind: 'addCode'; code: string }
  | { kind: 'removeCode'; code: string }
  | { kind: 'clear' }
  | { kind: 'load' }

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('addItem' as const),
    variantId: fc.constant('v-1'),
    qty: fc.integer({ min: 1, max: 5 }),
  }),
  fc.record({
    kind: fc.constant('updateQuantity' as const),
    variantId: fc.constant('v-1'),
    qty: fc.integer({ min: 1, max: 5 }),
  }),
  fc.record({ kind: fc.constant('removeItem' as const), variantId: fc.constant('v-1') }),
  fc.record({
    kind: fc.constant('addCode' as const),
    code: fc.stringMatching(/^[A-Za-z0-9]{1,10}$/),
  }),
  fc.record({
    kind: fc.constant('removeCode' as const),
    code: fc.stringMatching(/^[A-Za-z0-9]{1,10}$/),
  }),
  fc.constant({ kind: 'clear' as const }),
  fc.constant({ kind: 'load' as const }),
)

/** An adapter whose every cart call takes the next answer from `queue`, throwing it when it is an error. */
function adapterOf(queue: Array<ShopperCart | Error>) {
  const next = vi.fn(async (): Promise<ShopperCart> => {
    const out = queue.shift()
    if (out === undefined) throw new Error('the test queued no answer for this call')
    if (out instanceof Error) throw out
    return out
  })
  const cart = {
    get: next,
    addItem: next,
    removeItem: next,
    updateQuantity: next,
    clear: next,
    addCode: next,
    removeCode: next,
  }
  return { adapter: { cart } as unknown as CommerceAdapter, calls: next }
}

type Store = ReturnType<typeof createCartStore>

function run(store: Store, o: Op): Promise<void> {
  switch (o.kind) {
    case 'addItem':
      return store.addItem(o.variantId, o.qty)
    case 'updateQuantity':
      return store.updateQuantity(o.variantId, o.qty)
    case 'removeItem':
      return store.removeItem(o.variantId)
    case 'addCode':
      return store.addCode(o.code)
    case 'removeCode':
      return store.removeCode(o.code)
    case 'clear':
      return store.clear()
    case 'load':
      return store.load()
  }
}

/** The part of the state the API decides. */
const fromApi = (store: Store) => {
  const s = store.getState()
  return {
    items: s.items,
    subtotalMinor: s.subtotalMinor,
    currency: s.currency,
    totals: s.totals,
    promotions: s.promotions,
  }
}

describe('AC-2: the cart store keeps the API’s totals and codes on every path', () => {
  // Kills: a path that drops `totals` or `promotions` (clear sets its own zeroes today), so an element shows a total
  // the API did not give; or an initial state that claims totals before any answer.
  it('AC-2: property: over sequences of addItem, updateQuantity, removeItem, addCode, removeCode, clear and load each answered by a generated cart, at every prefix: none answered → totals null and promotions { codes: [], unavailable: false }; after one, items, subtotalMinor, currency, totals and promotions are the last answer’s and itemCount is Σ qty', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(op, answer), { maxLength: 8 }), async (steps) => {
        const queue: ShopperCart[] = steps.map(([, a]) => a)
        const { adapter, calls } = adapterOf(queue)
        const store = createCartStore(adapter)

        expect(store.getState().totals, 'before any answer').toBeNull()
        expect(store.getState().promotions, 'before any answer').toEqual({
          codes: [],
          unavailable: false,
        })
        for (const [i, [o, last]] of steps.entries()) {
          await run(store, o)
          expect(calls, `step ${i} (${o.kind}) asked the API once`).toHaveBeenCalledTimes(i + 1)
          expect(fromApi(store), `after step ${i} (${o.kind})`).toEqual({
            items: last.items,
            subtotalMinor: last.subtotalMinor,
            currency: last.currency,
            totals: last.totals,
            promotions: last.promotions,
          })
          expect(store.getState().itemCount, `after step ${i}`).toBe(
            last.items.reduce((n: number, l: CartItem) => n + l.qty, 0),
          )
        }
        store.destroy()
      }),
      { numRuns: 150 },
    )
  })
})

/** The refusals a code call can meet: the API's own, and a request that never got an answer (null). */
const REFUSALS: Array<{ code: string | null; status: number }> = [
  { code: 'cart.code_limit', status: 400 },
  { code: 'cart.code_invalid', status: 400 },
  { code: 'cart.missing', status: 404 },
  { code: 'cart.promotions_unavailable', status: 503 },
  { code: null, status: 0 },
]

describe('AC-3: a refused code call says why and keeps the cart', () => {
  // Kills: a refusal that wipes the shown discount, an element that cannot tell a limit from an outage, or an error
  // that outlives the next answered call.
  it('AC-3: property: a refused addCode or removeCode sets error and errorCode (the API’s code, null for a transport failure) and leaves items, totals and promotions as they were; the next answered call clears both', async () => {
    await fc.assert(
      fc.asyncProperty(
        answer,
        answer,
        fc.constantFrom(...REFUSALS),
        fc.constantFrom('addCode' as const, 'removeCode' as const),
        async (loaded, after, refusal, call) => {
          const error =
            refusal.code === null
              ? new TypeError('Failed to fetch')
              : new NymbalApiError(refusal.code, `refused ${refusal.code}`, refusal.status)
          const { adapter } = adapterOf([loaded, error, after])
          const store = createCartStore(adapter)
          await store.load()
          const before = fromApi(store)

          await (call === 'addCode' ? store.addCode('SAVE10') : store.removeCode('SAVE10'))
          expect({ error: store.getState().error, errorCode: store.getState().errorCode }).toEqual({
            error: error.message,
            errorCode: refusal.code,
          })
          expect(fromApi(store)).toEqual(before)
          expect(store.getState().itemCount).toBe(loaded.items.reduce((n: number, l: CartItem) => n + l.qty, 0))

          await store.load()
          expect({ error: store.getState().error, errorCode: store.getState().errorCode }).toEqual({
            error: null,
            errorCode: null,
          })
          expect(fromApi(store).totals).toEqual(after.totals)
          store.destroy()
        },
      ),
      { numRuns: 60 },
    )
  })

  // Kills: a blank Apply that posts (and is answered cart.code_invalid), or one that disturbs the state.
  it('AC-3: addCode of a blank code makes no request and changes no state; addCode trims what it sends', async () => {
    const loaded = fc.sample(answer, { numRuns: 1, seed: 7 })[0]!
    const queue: ShopperCart[] = [loaded, loaded]
    const { adapter, calls } = adapterOf(queue)
    const store = createCartStore(adapter)
    await store.load()
    const before = store.getState()

    for (const blank of ['', '   ', '\t \n']) await store.addCode(blank)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(store.getState()).toEqual(before)

    await store.addCode('  save10 ')
    expect(calls.mock.calls.at(-1)).toEqual(['save10'])
    expect(fromApi(store).promotions).toEqual(loaded.promotions)
  })
})
