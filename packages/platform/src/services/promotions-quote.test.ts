import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import type { Address, Cart, CartPromotions, Order, PromotionEffect } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import { createLogger } from '../logger.js'
import type { Repositories } from '../repositories/index.js'
import { scriptedEngine, type EngineAnswer } from '../tests/promotions.js'
import {
  cartCodes,
  cartTotals,
  createCartQuoter,
  createPlaceQuoter,
  evaluateBounded,
  orderPromotionRecord,
  sameQuote,
  type PlaceQuote,
} from './promotions-quote.js'
import { settleTotals } from './totals.js'

// The checkout decisions around an engine's answer: a scripted engine and a store that only runs its callback, so each
// test holds one decision still. The kernel's wiring of them is the integration suites'.

const logger = createLogger({ pretty: false, level: 'error' })
const NOW = new Date('2026-06-15T12:00:00.000Z')
const BOUND_MS = 20

function fakeStore() {
  const rolledBack: unknown[] = []
  const store = {
    read: (fn: (tx: unknown) => unknown) => fn({}),
    savepoint: async (fn: () => Promise<unknown>) => {
      try {
        return await fn()
      } catch (err) {
        rolledBack.push(err)
        throw err
      }
    },
  } as unknown as CommandStore
  return { store, rolledBack }
}

const catalogue = {
  variant: { findById: async (_tx: unknown, id: string) => ({ sku: `SKU-${id}` }) },
  productCategory: { listCategoriesForProduct: async () => ['cat-1'] },
} as unknown as Pick<Repositories, 'variant' | 'productCategory'>

function cartOf(codes: string[] = [], over: Partial<Cart> = {}): Cart {
  return {
    token: 'cart-1',
    customerId: 'cust-1',
    items: [
      {
        variantId: 'v-1',
        productId: 'p-1',
        productName: 'Widget',
        variantName: 'Default',
        priceMinor: 2500,
        imageUrl: '',
        qty: 2,
      },
    ],
    subtotalMinor: 5000,
    currency: 'GBP',
    source: 'storefront',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    expiresAt: NOW.toISOString(),
    ...(codes.length > 0 && {
      promotions: {
        codes,
        effects: [],
        provider: 'scripted',
        evaluatedAt: NOW.toISOString(),
        unavailable: false,
      },
    }),
    ...over,
  }
}

const takes =
  (amountMinor: number): EngineAnswer =>
  (session) => ({
    effects: session.codes.flatMap((code): PromotionEffect[] => [
      { kind: 'code_accepted', code },
      { kind: 'order', amountMinor, label: code, code },
    ]),
  })

function cartQuoter(engine: ReturnType<typeof scriptedEngine>) {
  return createCartQuoter({
    engine: engine.adapter,
    boundMs: BOUND_MS,
    store: fakeStore().store,
    catalogue,
    logger,
    now: () => NOW,
  })
}

function placeQuoter(
  engine: ReturnType<typeof scriptedEngine> | undefined,
  onUnavailable: 'proceed' | 'refuse' = 'proceed',
) {
  const { store, rolledBack } = fakeStore()
  const quoter = createPlaceQuoter({
    engine: engine?.adapter,
    boundMs: BOUND_MS,
    onUnavailable,
    store,
    catalogue,
    logger,
  })
  return { quoter, rolledBack }
}

const session = {
  id: 's',
  customerId: null,
  codes: [],
  currency: 'GBP',
  lines: [],
  shipping: null,
}

describe('evaluateBounded', () => {
  it('abandons an engine past the bound as a failure, and answers one within it', async () => {
    const engine = scriptedEngine()
    engine.answer(() => new Promise(() => undefined))
    await expect(evaluateBounded(engine.adapter, session, {}, BOUND_MS)).rejects.toThrow(
      `past the ${BOUND_MS} ms bound`,
    )
    engine.answer(() => ({ effects: [], evaluationId: 'e-1' }))
    await expect(evaluateBounded(engine.adapter, session, {}, BOUND_MS)).resolves.toEqual({
      effects: [],
      evaluationId: 'e-1',
    })
  })

  it('never abandons an inTransaction engine, however long it takes past the bound', async () => {
    const engine = scriptedEngine({ inTransaction: true })
    engine.answer(async () => {
      await new Promise((resolve) => setTimeout(resolve, BOUND_MS * 3))
      return { effects: [], evaluationId: 'late' }
    })
    await expect(evaluateBounded(engine.adapter, session, {}, BOUND_MS)).resolves.toMatchObject({
      evaluationId: 'late',
    })
  })
})

describe('cartCodes', () => {
  const said = (over: Partial<CartPromotions>): CartPromotions => ({
    codes: ['SAVE'],
    effects: [],
    provider: 'p',
    evaluatedAt: NOW.toISOString(),
    unavailable: false,
    ...over,
  })

  it('a cart with no record has no codes and is not unavailable', () => {
    expect(cartCodes(undefined)).toEqual({ codes: [], unavailable: false })
  })

  it('while unavailable every code is pending, whatever effects are stored', () => {
    expect(
      cartCodes(said({ unavailable: true, effects: [{ kind: 'code_accepted', code: 'SAVE' }] })),
    ).toEqual({ codes: [{ code: 'SAVE', status: 'pending' }], unavailable: true })
  })

  it('reads each code’s own verdict in any case, and a code the engine did not answer as unanswered', () => {
    const { codes } = cartCodes(
      said({
        codes: ['Save', 'BAD', 'SILENT'],
        effects: [
          { kind: 'code_accepted', code: 'SAVE' },
          { kind: 'code_rejected', code: 'bad', reason: 'expired' },
          { kind: 'order', amountMinor: 1, label: 'SILENT', code: 'SILENT' },
        ],
      }),
    )
    expect(codes).toEqual([
      { code: 'Save', status: 'accepted' },
      { code: 'BAD', status: 'rejected', reason: 'expired' },
      { code: 'SILENT', status: 'rejected', reason: 'unanswered' },
    ])
  })
})

describe('cartTotals', () => {
  it('settles the stored effects, and a cart with no record at full price', () => {
    const cart = cartOf(['SAVE'])
    cart.promotions!.effects = [{ kind: 'order', amountMinor: 700, label: 'SAVE', code: 'SAVE' }]
    expect(cartTotals(cart)).toMatchObject({ discountTotalMinor: 700, totalMinor: 4300 })
    expect(cartTotals(cartOf())).toMatchObject({ discountTotalMinor: 0, totalMinor: 5000 })
  })
})

describe('createCartQuoter', () => {
  it('asks no engine for a cart with no code when the engine is not automatic', async () => {
    const engine = scriptedEngine()
    await expect(cartQuoter(engine).quote(cartOf(), false)).resolves.toBeUndefined()
    expect(engine.calls).toEqual([])
  })

  it('builds the session from the cart and the catalogue, and evaluates it dry', async () => {
    const engine = scriptedEngine()
    engine.answer(takes(500))
    await cartQuoter(engine).quote(cartOf(['SAVE']), false)
    expect(engine.calls).toEqual([
      {
        opts: { dry: true },
        session: {
          id: 'cart-1',
          customerId: 'cust-1',
          codes: ['SAVE'],
          currency: 'GBP',
          shipping: null,
          lines: [
            {
              id: 'v-1',
              variantId: 'v-1',
              sku: 'SKU-v-1',
              productId: 'p-1',
              categoryIds: ['cat-1'],
              unitMinor: 2500,
              qty: 2,
            },
          ],
        },
      },
    ])
  })

  it('stores the engine’s effects with its provider and the time', async () => {
    const engine = scriptedEngine({ providerName: 'engine-a' })
    engine.answer(takes(500))
    await expect(cartQuoter(engine).quote(cartOf(['SAVE']), false)).resolves.toEqual({
      codes: ['SAVE'],
      effects: [
        { kind: 'code_accepted', code: 'SAVE' },
        { kind: 'order', amountMinor: 500, label: 'SAVE', code: 'SAVE' },
      ],
      provider: 'engine-a',
      evaluatedAt: NOW.toISOString(),
      unavailable: false,
    })
  })

  it('an automatic engine is asked with no code; only an answer with effects is stored', async () => {
    const engine = scriptedEngine({ capabilities: ['codes', 'automatic'] })
    engine.answer(() => ({ effects: [] }))
    await expect(cartQuoter(engine).quote(cartOf(), false)).resolves.toBeUndefined()
    engine.answer(() => ({
      effects: [{ kind: 'order', amountMinor: 100, label: 'Auto', code: 'auto' }],
    }))
    const stored = await cartQuoter(engine).quote(cartOf(), false)
    expect(stored?.effects).toHaveLength(1)
    expect(engine.calls).toHaveLength(2)
  })

  it('the free-order rule turns an accepted code that would zero the cart into a rejection with no money', async () => {
    const engine = scriptedEngine()
    engine.answer(takes(5000))
    const stored = await cartQuoter(engine).quote(cartOf(['FREE']), false)
    expect(stored?.effects).toEqual([
      { kind: 'code_rejected', code: 'FREE', reason: 'free_order_unsupported' },
    ])
    expect(stored?.unavailable).toBe(false)
  })

  it('an outage is recorded as unavailable with no money when not strict, and refuses the command when strict', async () => {
    const engine = scriptedEngine()
    engine.fail()
    await expect(cartQuoter(engine).quote(cartOf(['SAVE']), false)).resolves.toMatchObject({
      codes: ['SAVE'],
      effects: [],
      unavailable: true,
    })
    await expect(cartQuoter(engine).quote(cartOf(['SAVE']), true)).rejects.toMatchObject({
      code: 'cart.promotions_unavailable',
    })
  })

  it('an outage on an automatic engine with no code on the cart stores nothing', async () => {
    const engine = scriptedEngine({ capabilities: ['automatic'] })
    engine.fail()
    await expect(cartQuoter(engine).quote(cartOf(), false)).resolves.toBeUndefined()
  })
})

describe('createPlaceQuoter', () => {
  const extras = {
    customerId: 'cust-2',
    email: 'a@b.test',
    shipTo: { country: 'GB' } as unknown as Address,
  }

  it('with no engine, or no code and no automatic engine, settles at full price without asking', async () => {
    const plain = {
      skipped: false,
      effects: [],
      totals: { discountTotalMinor: 0, totalMinor: 5000 },
    }
    await expect(
      placeQuoter(undefined).quoter.dry(cartOf(['SAVE']), extras),
    ).resolves.toMatchObject(plain)
    const engine = scriptedEngine()
    await expect(placeQuoter(engine).quoter.dry(cartOf(), extras)).resolves.toMatchObject(plain)
    expect(engine.calls).toEqual([])
  })

  it('a dry quote carries the checkout’s extras; a reservation carries the order id', async () => {
    const engine = scriptedEngine()
    engine.answer(() => ({
      effects: [
        { kind: 'code_accepted', code: 'SAVE' },
        { kind: 'order', amountMinor: 500, label: 'SAVE', code: 'SAVE' },
      ],
      evaluationId: 'e',
    }))
    const { quoter } = placeQuoter(engine)
    const dry = await quoter.dry(cartOf(['SAVE']), extras)
    const reserved = await quoter.reserve(cartOf(['SAVE']), extras, 'order-9')
    expect(dry).toMatchObject({ evaluationId: 'e', skipped: false, totals: { totalMinor: 4500 } })
    expect(reserved).toEqual(dry)
    expect(engine.calls.map((c) => c.opts)).toEqual([{ dry: true }, { orderId: 'order-9' }])
    expect(engine.calls[0]!.session).toMatchObject({
      customerId: 'cust-2',
      email: 'a@b.test',
      shipTo: extras.shipTo,
    })
  })

  it('a free order at a reservation is rolled back in its savepoint and answered at full price', async () => {
    const engine = scriptedEngine()
    engine.answer(takes(5000))
    const { quoter, rolledBack } = placeQuoter(engine)
    const quote = await quoter.reserve(cartOf(['FREE']), extras, 'order-1')
    expect(rolledBack).toHaveLength(1)
    expect(quote.totals).toMatchObject({ discountTotalMinor: 0, totalMinor: 5000 })
    expect(quote.effects).toEqual([
      { kind: 'code_rejected', code: 'FREE', reason: 'free_order_unsupported' },
    ])
  })

  it('a free order on a dry quote answers the same full price', async () => {
    const engine = scriptedEngine()
    engine.answer(takes(5000))
    const quote = await placeQuoter(engine).quoter.dry(cartOf(['FREE']), extras)
    expect(quote.totals.totalMinor).toBe(5000)
    expect(quote.skipped).toBe(false)
  })

  it('an outage with a code on the cart refuses under either setting, at both steps', async () => {
    for (const setting of ['proceed', 'refuse'] as const) {
      const engine = scriptedEngine()
      engine.fail()
      const { quoter } = placeQuoter(engine, setting)
      await expect(quoter.dry(cartOf(['SAVE']), extras)).rejects.toMatchObject({
        code: 'checkout.promotions_unavailable',
      })
      await expect(quoter.reserve(cartOf(['SAVE']), extras, 'o')).rejects.toMatchObject({
        code: 'checkout.promotions_unavailable',
      })
    }
  })

  it('an outage with no code follows the setting: proceed places at full price marked skipped, refuse refuses', async () => {
    const down = () => {
      const engine = scriptedEngine({ capabilities: ['automatic'] })
      engine.fail()
      return engine
    }
    await expect(
      placeQuoter(down(), 'proceed').quoter.dry(cartOf(), extras),
    ).resolves.toMatchObject({
      skipped: true,
      totals: { totalMinor: 5000 },
    })
    await expect(
      placeQuoter(down(), 'refuse').quoter.reserve(cartOf(), extras, 'o'),
    ).rejects.toMatchObject({ code: 'checkout.promotions_unavailable' })
  })
})

const quoteOf = (effects: PromotionEffect[], cart: Cart, evaluationId?: string): PlaceQuote => ({
  totals: settleTotals({
    currency: cart.currency,
    lines: cart.items.map((i) => ({ id: i.variantId, unitMinor: i.priceMinor, qty: i.qty })),
    shipping: null,
    effects,
    tax: null,
    pricesIncludeTax: false,
  }),
  effects,
  ...(evaluationId !== undefined && { evaluationId }),
  skipped: false,
})

describe('orderPromotionRecord', () => {
  it('keeps nothing when no code was accepted, no money moved and no evaluation was named', () => {
    const quote = quoteOf([{ kind: 'code_rejected', code: 'X', reason: 'expired' }], cartOf())
    expect(orderPromotionRecord('p', 's', quote)).toBeUndefined()
  })

  it('keeps the provider, the session, the accepted codes and the money that counted', () => {
    const order = { kind: 'order', amountMinor: 500, label: 'SAVE', code: 'SAVE' } as const
    const quote = quoteOf([{ kind: 'code_accepted', code: 'SAVE' }, order], cartOf())
    expect(orderPromotionRecord('p', 's', quote)).toEqual({
      provider: 'p',
      sessionId: 's',
      codes: ['SAVE'],
      effects: quote.totals.applied,
    })
  })

  it('keeps an evaluation id alone, for an engine that names one and moves nothing', () => {
    expect(orderPromotionRecord('p', 's', quoteOf([], cartOf(), 'e-1'))).toEqual({
      provider: 'p',
      sessionId: 's',
      codes: [],
      effects: [],
      evaluationId: 'e-1',
    })
  })
})

describe('sameQuote', () => {
  const shipTo = {
    firstName: 'A',
    lastName: 'B',
    addressLine1: '1 St',
    city: 'L',
    region: '',
    postalCode: 'E1',
    country: 'GB',
  } as Address

  const accepted = (...codes: string[]): PromotionEffect[] =>
    codes.map((code) => ({ kind: 'code_accepted', code }))

  /** A pending order written from exactly this cart at exactly this quote. */
  function orderFrom(cart: Cart, quote: PlaceQuote, codes: string[], address: Address): Order {
    return {
      totalMinor: quote.totals.totalMinor,
      discountTotalMinor: quote.totals.discountTotalMinor,
      currency: cart.currency,
      shippingAddress: address,
      metadata: codes.length > 0 ? { promotions: { codes } } : {},
      lineItems: cart.items.map((i) => ({
        variantId: i.variantId,
        qty: i.qty,
        unitPriceMinor: i.priceMinor,
      })),
    } as unknown as Order
  }

  const discounted: PromotionEffect[] = [
    { kind: 'code_accepted', code: 'SAVE' },
    { kind: 'order', amountMinor: 500, label: 'SAVE', code: 'SAVE' },
  ]
  const cart = cartOf(['SAVE'])
  const quote = quoteOf(discounted, cart)
  const order = orderFrom(cart, quote, ['SAVE'], shipTo)

  it('holds for the order written from this cart at this quote', () => {
    expect(sameQuote(order, cart, quote, shipTo)).toBe(true)
  })

  it.each([
    ['the total', { totalMinor: 4501 }],
    ['the discount', { discountTotalMinor: 501 }],
    ['the currency', { currency: 'USD' }],
    ['the line count', { lineItems: [...order.lineItems, order.lineItems[0]] }],
    ['the variant', { lineItems: [{ ...order.lineItems[0], variantId: 'v-2' }] }],
    ['the quantity', { lineItems: [{ ...order.lineItems[0], qty: 3 }] }],
    ['the unit price', { lineItems: [{ ...order.lineItems[0], unitPriceMinor: 2400 }] }],
    ['the address', { shippingAddress: { ...shipTo, city: 'Leeds' } }],
    ['a code gone from the order', { metadata: {} }],
    ['another code on the order', { metadata: { promotions: { codes: ['OTHER'] } } }],
    ['an extra code on the order', { metadata: { promotions: { codes: ['SAVE', 'MORE'] } } }],
  ])('refuses an order differing only in %s', (_what, change) => {
    expect(sameQuote({ ...order, ...change } as Order, cart, quote, shipTo)).toBe(false)
  })

  it('reads codes in any case and order', () => {
    const both = quoteOf(accepted('Alpha', 'beta'), cart)
    const onOrder = orderFrom(cart, both, ['BETA', 'alpha'], shipTo)
    expect(sameQuote(onOrder, cart, both, shipTo)).toBe(true)
  })

  it('counts an absent optional address field equal to an empty one, in any key order', () => {
    const { region: _absent, ...rest } = shipTo as Address & { region: string }
    const reordered = Object.fromEntries(Object.entries(rest).reverse()) as unknown as Address
    expect(sameQuote({ ...order, shippingAddress: reordered }, cart, quote, shipTo)).toBe(true)
  })

  it('property: only the exact cart, quantities and prices of the order are the same quote', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 9_999 }),
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 9_999 }),
        (qty, priceMinor, shownQty, shownPrice) => {
          const onOrder = cartOf([], {
            items: [{ ...cart.items[0]!, qty, priceMinor }],
          })
          const shown = cartOf([], {
            items: [{ ...cart.items[0]!, qty: shownQty, priceMinor: shownPrice }],
          })
          const atPrice = quoteOf([], shown)
          // The order total is written to match, so only the line comparison can tell them apart.
          const placed = {
            ...orderFrom(onOrder, quoteOf([], onOrder), [], shipTo),
            totalMinor: atPrice.totals.totalMinor,
          }
          expect(sameQuote(placed, shown, atPrice, shipTo)).toBe(
            qty === shownQty && priceMinor === shownPrice,
          )
        },
      ),
    )
  })
})

describe('the bound clears its timer', () => {
  it('a settled evaluation leaves no timer behind', async () => {
    vi.useFakeTimers()
    try {
      const engine = scriptedEngine()
      engine.answer(() => ({ effects: [] }))
      await evaluateBounded(engine.adapter, session, {}, BOUND_MS)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
