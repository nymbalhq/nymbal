import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Address, OrderLineItem, PaymentIntentParams } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import {
  addLine,
  putCode,
  readCart,
  seedPromotion,
  uniqueCode,
  type PricedCart,
  type SeededPromotion,
  type Shop,
} from '../support/promotions.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { bearer, lapsedToken, registeredCustomer } from '../support/recently-viewed.js'
import { primedShopper } from '../support/security.js'
import {
  both,
  offered,
  placeOrder,
  quote,
  shippingTaxOf,
  TABLE,
  UNSHIPPED,
  withShipping,
  type CheckoutAnswer,
  type ErrorBody,
  type QuoteBody,
  type ShippingRow,
} from '../support/shipping.js'
import { RATES, taxOnTop, taxWithin, UNTAXED, withTax, type RateRow } from '../support/tax.js'

// Shipping through a checkout over HTTP on served kernels (SQLite) with the native engines: stores that set no table
// (with no tax, tax on top and tax included), and stores with a table (tax on top and tax included). What the quote
// answers and leaves behind, what the order records and is charged, and what a caller that sent no total is refused.

interface Intents {
  created: { id: string; amountMinor: number }[]
  cancelled: string[]
}

interface Store {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  intents: Intents
  /** The store's shipping table, [] for none. */
  table: readonly ShippingRow[]
  /** The percent each destination is taxed at, and whether its row taxes shipping; absent: untaxed. */
  taxed: boolean
  inclusive: boolean
}

interface OrderRow {
  subtotal_minor: number
  discount_total_minor: number
  shipping_total_minor: number
  tax_total_minor: number
  total_minor: number
  status: string
  payment_intent_id: string | null
}

/** Every intent a kernel's checkout creates or cancels with its payments adapter. */
function watchIntents(kernel: Kernel): Intents {
  const intents: Intents = { created: [], cancelled: [] }
  const payments = kernel.app.adapters.payments
  const create = payments.createPaymentIntent.bind(payments)
  const cancel = payments.cancelPaymentIntent.bind(payments)
  payments.createPaymentIntent = async (params: PaymentIntentParams) => {
    const intent = await create(params)
    intents.created.push({ id: intent.id, amountMinor: intent.amountMinor })
    return intent
  }
  payments.cancelPaymentIntent = async (id: string) => {
    intents.cancelled.push(id)
    return cancel(id)
  }
  return intents
}

/** GB, CA and NY tax shipping; Germany's row exempts it; Japan has no row. */
const TAX_ROWS: RateRow[] = [
  { country: 'GB', percent: 20, taxShipping: true },
  { country: 'US', region: 'CA', percent: 7.25, taxShipping: true },
  { country: 'US', region: 'NY', percent: 8.875, taxShipping: true },
  { country: 'DE', percent: 19, taxShipping: false },
]

interface Destination {
  shipTo: Address
  /** The tax row's percent, 0 outside every row. */
  percent: number
  taxShipping: boolean
}

const DESTINATIONS: readonly Destination[] = [
  { shipTo: address, percent: 20, taxShipping: true },
  {
    shipTo: { ...address, city: 'Los Angeles', region: 'CA', postalCode: '90001', country: 'US' },
    percent: 7.25,
    taxShipping: true,
  },
  {
    shipTo: { ...address, city: 'Berlin', region: '', postalCode: '10115', country: 'DE' },
    percent: 19,
    taxShipping: false,
  },
  { shipTo: UNTAXED, percent: 0, taxShipping: false },
]

async function serve(opts: {
  table: readonly ShippingRow[]
  rates?: RateRow[]
  inclusive?: boolean
}): Promise<Store> {
  const k = await createKernel({
    dialect: 'sqlite',
    configure: both(
      withTax({ rates: opts.rates ?? [], pricesIncludeTax: opts.inclusive ?? false }),
      withShipping(opts.table),
    ),
  })
  const served = await serveKernel(k)
  return {
    k,
    served,
    raw: openRaw(k.dialect, k.target),
    intents: watchIntents(k),
    table: opts.table,
    taxed: (opts.rates ?? []).length > 0,
    inclusive: opts.inclusive ?? false,
  }
}

/** No table, no tax: the harness as it was before shipping existed. */
let plain: Store
/** No table, tax on top of prices. */
let onTop: Store
/** No table, prices include tax. */
let within: Store
/** The table, tax on top. */
let shipped: Store
/** The table, prices include tax. */
let shippedWithin: Store

beforeAll(async () => {
  ;[plain, onTop, within, shipped, shippedWithin] = await Promise.all([
    serve({ table: [] }),
    serve({ table: [], rates: RATES }),
    serve({ table: [], rates: RATES, inclusive: true }),
    serve({ table: TABLE, rates: TAX_ROWS }),
    serve({ table: TABLE, rates: TAX_ROWS, inclusive: true }),
  ])
}, 60_000)

afterAll(async () => {
  for (const s of [plain, onTop, within, shipped, shippedWithin]) {
    await s?.raw.close()
    await s?.served.stop()
  }
})

const pendingEmail = () => `buyer-${randomUUID()}+stub-pending@shipping.test`

interface Line {
  priceMinor: number
  qty: number
}

interface Basket {
  shop: Shop
  seeded: Seeded[]
  cart: PricedCart
  promotion?: SeededPromotion
}

/** A shopper of its own with these lines and, given a percent in basis points, a code taking it off the order. */
async function basket(
  s: Store,
  lines: readonly Line[],
  bps: number | null = null,
): Promise<Basket> {
  // A raw write waits on the store's lock with the thread asleep: the last command's pass must be done first.
  await s.k.app.relay.drain()
  const promotion =
    bps === null
      ? undefined
      : await seedPromotion(s.k, { code: uniqueCode('SHIP'), kind: 'percent', percentBps: bps })
  const seeded = await Promise.all(
    lines.map((l) => seedVariant(s.k, l.qty + 5, { priceMinor: l.priceMinor })),
  )
  const shop = await primedShopper(s.served.baseUrl)
  expect((await readCart(shop)).status).toBe(200)
  for (const [i, v] of seeded.entries()) {
    const added = await addLine(shop, v, lines[i]!.qty)
    expect(added.status, JSON.stringify(added.body)).toBe(200)
  }
  let cart = (await readCart(shop)).body.data!
  if (promotion !== undefined) {
    const coded = await putCode(shop, promotion.code)
    expect(coded.status, JSON.stringify(coded.body)).toBe(200)
    cart = coded.body.data!
  }
  return { shop, seeded, cart, ...(promotion !== undefined && { promotion }) }
}

function orderRow(raw: RawReader, orderId: string): Promise<OrderRow> {
  return raw.one<OrderRow>(
    'SELECT subtotal_minor, discount_total_minor, shipping_total_minor, tax_total_minor, total_minor, status, ' +
      'payment_intent_id FROM orders WHERE id = ?',
    [orderId],
  )
}

function orderOf(s: Store, orderId: string) {
  return s.k.store.read(async (tx) => (await s.k.repos.order.findById(tx, orderId))!)
}

const ordersBy = (s: Store, email: string) => s.raw.count('orders', 'email = ?', [email])

/** What a checkout or a quote can leave behind for this basket, as a second connection reads it. */
async function traces(s: Store, b: Basket) {
  return {
    orders: await s.raw.count('orders'),
    reservations: await Promise.all(
      b.seeded.map((v) => s.raw.count('inventory_reservations', 'variant_id = ?', [v.variantId])),
    ),
    redemptions:
      b.promotion === undefined
        ? 0
        : await s.raw.count('promotion_redemptions', 'promotion_id = ?', [b.promotion.id]),
    intentsCreated: s.intents.created.length,
    intentsCancelled: s.intents.cancelled.length,
    cart: await s.raw.one<{ updated_at: unknown; expires_at: unknown; promotions: unknown }>(
      'SELECT updated_at, expires_at, promotions FROM carts WHERE token = ?',
      [b.cart.token],
    ),
  }
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0)

/** The goods after their discount, as the cart's totals give them. */
const goodsOf = (cart: PricedCart): number =>
  cart.totals.subtotalMinor - (cart.totals.discountTotalMinor - cart.totals.shippingDiscountMinor)

/** What a store with no table charges for a cart: the goods, plus the tax on top of each discounted line. */
function dueWithoutShipping(s: Store, cart: PricedCart, percent: number): number {
  if (!s.taxed || s.inclusive) return cart.totals.totalMinor
  return (
    cart.totals.totalMinor +
    sum(cart.totals.lines.map((l) => taxOnTop(l.subtotalMinor - l.discountMinor, percent)))
  )
}

/** Pays `row.total_minor` for the order's intent and answers the order's status after. */
async function settle(s: Store, answer: CheckoutAnswer, row: OrderRow): Promise<string> {
  const done = await s.k.services.checkout.finalize(answer.paymentIntent.id, {
    amountMinor: row.total_minor,
    currency: 'GBP',
  })
  expect(done.finalized, JSON.stringify(done)).toBe(true)
  return (await orderRow(s.raw, answer.orderId)).status
}

const errorOf = (body: { error?: unknown }): Partial<ErrorBody> =>
  (body.error ?? {}) as Partial<ErrorBody>

/** The quote's answer, once it has answered 200. */
async function quoteData(shop: Shop, body: Parameters<typeof quote>[1]): Promise<QuoteBody> {
  const res = await quote(shop, body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

// At least 100 a unit, so every line keeps money after a code below 90%.
const arbLines = fc.array(
  fc.record({
    priceMinor: fc.integer({ min: 100, max: 40_000 }),
    qty: fc.integer({ min: 1, max: 4 }),
  }),
  { minLength: 1, maxLength: 3 },
)

const arbBps = fc.option(fc.integer({ min: 1, max: 9_000 }), { nil: null })

const STANDARD_ONLY = [{ id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: null }]

describe('AC-6: a store that sets no table is unchanged', () => {
  // Kills: a store that configured nothing charging shipping, writing new order metadata, or refusing a caller that
  // sent no total when nothing on top is charged.
  it('AC-6: property: with no table, with and without a code and tax rates, the quote is the one free standard option, and the checkout places at the tax-only totals with shipping 0, no metadata.shipping, and needs no total unless tax is added on top', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLines,
        arbBps,
        fc.constantFrom('plain', 'onTop', 'within'),
        async (lines, bps, which) => {
          const s = { plain, onTop, within }[which]
          const b = await basket(s, lines, bps)
          const due = dueWithoutShipping(s, b.cart, 20)

          const quoted = await quote(b.shop, { shippingAddress: address })

          expect(quoted.status, JSON.stringify(quoted.body)).toBe(200)
          const q = quoted.body.data!
          expect(q.options).toEqual(STANDARD_ONLY)
          expect(q.shippingOptionId).toBe('standard')
          expect(q.totals.shippingTotalMinor).toBe(0)
          expect(q.totals.totalMinor).toBe(due)

          const needsTotal = s.taxed && !s.inclusive
          const res = await placeOrder(
            b.shop,
            pendingEmail(),
            needsTotal ? { expectedTotalMinor: due } : {},
          )

          expect(res.status, JSON.stringify(res.body)).toBe(200)
          const row = await orderRow(s.raw, res.body.data!.orderId)
          expect(row.shipping_total_minor).toBe(0)
          expect(row.total_minor).toBe(due)
          expect(row.total_minor).toBe(q.totals.totalMinor)
          const order = await orderOf(s, res.body.data!.orderId)
          expect((order.metadata as { shipping?: unknown }).shipping).toBeUndefined()
        },
      ),
      { numRuns: 12 },
    )
  })
})

describe('AC-7: POST /api/checkout/quote', () => {
  // Kills: options not filtered by the address, the totals priced at another option than the one named, an option
  // the caller chose ignored.
  it('AC-7: answers the address’s options, the first as shippingOptionId with its amount in the totals; another offered id prices that option', async () => {
    const b = await basket(shipped, [{ priceMinor: 1_250, qty: 2 }])
    const options = offered(TABLE, 'GB', goodsOf(b.cart))

    const first = await quote(b.shop, { shippingAddress: address })

    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const q = first.body.data!
    expect(q.currency).toBe('GBP')
    expect(q.options).toEqual(options)
    expect(q.shippingOptionId).toBe(options[0]!.id)
    expect(q.totals.shippingTotalMinor).toBe(options[0]!.amountMinor)
    expect(q.totals.totalMinor).toBe(
      q.totals.subtotalMinor -
        q.totals.discountTotalMinor +
        q.totals.shippingTotalMinor +
        q.totals.taxTotalMinor,
    )

    const express = await quote(b.shop, { shippingAddress: address, shippingOptionId: 'express' })

    expect(express.status, JSON.stringify(express.body)).toBe(200)
    const e = express.body.data!
    expect(e.shippingOptionId).toBe('express')
    expect(e.options).toEqual(q.options)
    expect(e.totals.shippingTotalMinor).toBe(999)
    // GB taxes shipping at 20% on top: the difference is the shipping and its tax, the goods unchanged.
    expect(e.totals.totalMinor - q.totals.totalMinor).toBe(
      999 + taxOnTop(999, 20) - (options[0]!.amountMinor + taxOnTop(options[0]!.amountMinor, 20)),
    )
    expect(e.totals.subtotalMinor).toBe(q.totals.subtotalMinor)
  })

  // Kills: the free-over threshold compared with the subtotal before the code, so a shopper whose code takes them
  // under it is quoted free shipping and refused at payment, or the other way round.
  it('AC-7: an option is free when the goods after the code reach freeOverMinor, and charged one unit below it, though both subtotals are over it', async () => {
    for (const [priceMinor, free] of [
      [5_556, true],
      [5_554, false],
    ] as const) {
      const b = await basket(shipped, [{ priceMinor, qty: 1 }], 1_000)
      expect(b.cart.totals.subtotalMinor).toBeGreaterThanOrEqual(5_000)
      expect(goodsOf(b.cart), 'goods after the code').toBe(free ? 5_001 : 4_999)

      const res = await quote(b.shop, { shippingAddress: address, shippingOptionId: 'standard' })

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const standard = res.body.data!.options.find((o) => o.id === 'standard')!
      expect(standard.amountMinor, `price ${priceMinor}`).toBe(free ? 0 : 399)
      expect(res.body.data!.totals.shippingTotalMinor).toBe(standard.amountMinor)
    }
  })

  it('AC-7: an address no option ships to is 422 checkout.no_shipping; an id not offered there is 409 checkout.shipping_option_unavailable with the offered options in context', async () => {
    const b = await basket(shipped, [{ priceMinor: 1_000, qty: 1 }])

    const nowhere = await quote(b.shop, { shippingAddress: UNSHIPPED })
    expect([nowhere.status, errorOf(nowhere.body).code], JSON.stringify(nowhere.body)).toEqual([
      422,
      'checkout.no_shipping',
    ])

    const europe = await quote(b.shop, { shippingAddress: address, shippingOptionId: 'europe' })
    expect([europe.status, errorOf(europe.body).code], JSON.stringify(europe.body)).toEqual([
      409,
      'checkout.shipping_option_unavailable',
    ])
    expect(errorOf(europe.body).context?.['options']).toEqual(offered(TABLE, 'GB', goodsOf(b.cart)))
  })

  it('AC-7: no cart cookie is 400, an unknown cart 404, a malformed address 400 validation.failed, each as POST /api/checkout answers the same cart', async () => {
    const noCookie = await primedShopper(shipped.served.baseUrl)
    const none = await quote(noCookie, { shippingAddress: address })
    expect([none.status, errorOf(none.body).code]).toEqual([400, 'checkout.no_cart'])

    const unknown = await primedShopper(shipped.served.baseUrl)
    unknown.jar.set('nymbal.cart', randomUUID())
    const missing = await quote(unknown, { shippingAddress: address })
    const atCheckout = await placeOrder(unknown, pendingEmail())
    expect(missing.status).toBe(404)
    expect([missing.status, errorOf(missing.body).code]).toEqual([
      atCheckout.status,
      errorOf(atCheckout.body).code,
    ])

    const b = await basket(shipped, [{ priceMinor: 1_000, qty: 1 }])
    const { country: _country, ...noCountry } = address
    for (const malformed of [noCountry, { ...address, firstName: 42 }, 'GB', null]) {
      const res = await quote(b.shop, { shippingAddress: malformed })
      expect([res.status, errorOf(res.body).code], JSON.stringify(malformed)).toEqual([
        400,
        'validation.failed',
      ])
    }
  })

  // Kills: a quote on a cart that became an order answering anything but the refusal POST /api/checkout gives, so the
  // storefront cannot find its order; or a key handed out where the checkout's own refusal mints one.
  it('AC-7: a cart that became an order is 409 checkout.cart_empty naming that order, with no key', async () => {
    const b = await basket(shipped, [{ priceMinor: 1_000, qty: 1 }])
    const q = await quoteData(b.shop, { shippingAddress: address, shippingOptionId: 'collect' })
    // Paid at once by the stub, so the order is confirmed and the cart cleared.
    const placed = await placeOrder(b.shop, `buyer-${randomUUID()}@shipping.test`, {
      shippingOptionId: 'collect',
      expectedTotalMinor: q.totals.totalMinor,
    })
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)

    const after = await quote(b.shop, { shippingAddress: address })

    expect([after.status, errorOf(after.body).code], JSON.stringify(after.body)).toEqual([
      409,
      'checkout.cart_empty',
    ])
    expect(errorOf(after.body).context).toEqual({ orderNumber: placed.body.data!.orderNumber })
  })

  it('AC-7: a bearer that does not verify is 401 auth.token_invalid, as at POST /api/checkout', async () => {
    const customer = await registeredCustomer(shipped.k)
    const b = await basket(shipped, [{ priceMinor: 1_000, qty: 1 }])
    const lapsed = bearer(await lapsedToken(shipped.served.kernel, customer, 'expired'))

    const res = await quote(b.shop, { shippingAddress: address }, lapsed)
    const atCheckout = await placeOrder(b.shop, customer.email, {}, lapsed)

    expect([res.status, errorOf(res.body).code]).toEqual([401, 'auth.token_invalid'])
    expect([res.status, errorOf(res.body).code]).toEqual([
      atCheckout.status,
      errorOf(atCheckout.body).code,
    ])
  })

  // Kills: a quote that reserves stock, redeems a code, creates an intent or an order, or touches the cart (extending
  // its life, or re-pricing its codes).
  it('AC-7: quoting every option, with a code, refused or not, writes nothing: no order, reservation, redemption or intent, and the cart’s updated_at, expires_at and promotions do not move', async () => {
    const b = await basket(shipped, [{ priceMinor: 2_222, qty: 3 }], 1_500)
    const before = await traces(shipped, b)

    for (const shippingOptionId of [undefined, 'standard', 'express', 'collect', 'europe']) {
      await quote(b.shop, {
        shippingAddress: address,
        ...(shippingOptionId !== undefined && { shippingOptionId }),
      })
    }
    await quote(b.shop, { shippingAddress: UNSHIPPED })
    const last = await quote(b.shop, { shippingAddress: address, shippingOptionId: 'express' })

    expect(last.status, JSON.stringify(last.body)).toBe(200)
    expect(await traces(shipped, b)).toEqual(before)
  })
})

const arbDestination = fc.constantFrom(...DESTINATIONS)

describe('AC-8: the quote is the charge', () => {
  // Kills: place pricing shipping or its tax differently from the quote (every element checkout refused
  // total_changed), shipping not taxed where the row taxes it, or the intent leaving the shipping out.
  it('AC-8: property: for a generated cart, code, destination, flag and offered option, checking out at the quote’s option and total writes the quote’s columns, the option in metadata.shipping and the quote’s shipping tax, and the intent of that total confirms the order', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLines,
        arbBps,
        arbDestination,
        fc.boolean(),
        fc.nat({ max: 10 }),
        async (lines, bps, to: Destination, inclusive, pick) => {
          const s = inclusive ? shippedWithin : shipped
          const b = await basket(s, lines, bps)
          const options = offered(TABLE, to.shipTo.country, goodsOf(b.cart))
          const option = options[pick % options.length]!

          const quoted = await quote(b.shop, {
            shippingAddress: to.shipTo,
            shippingOptionId: option.id,
          })
          expect(quoted.status, JSON.stringify(quoted.body)).toBe(200)
          const q = quoted.body.data!
          expect(q.shippingOptionId).toBe(option.id)
          expect(q.totals.shippingTotalMinor).toBe(option.amountMinor)
          const taxOf = inclusive ? taxWithin : taxOnTop
          const net = q.totals.shippingTotalMinor - q.totals.shippingDiscountMinor
          expect(shippingTaxOf(q.totals), 'the shipping tax at the row’s rate').toBe(
            to.taxShipping ? taxOf(net, to.percent) : 0,
          )

          const res = await placeOrder(b.shop, pendingEmail(), {
            shippingAddress: to.shipTo,
            shippingOptionId: q.shippingOptionId,
            expectedTotalMinor: q.totals.totalMinor,
          })

          expect(res.status, JSON.stringify(res.body)).toBe(200)
          const answer = res.body.data!
          const row = await orderRow(s.raw, answer.orderId)
          expect([
            row.subtotal_minor,
            row.discount_total_minor,
            row.shipping_total_minor,
            row.tax_total_minor,
            row.total_minor,
          ]).toEqual([
            q.totals.subtotalMinor,
            q.totals.discountTotalMinor,
            q.totals.shippingTotalMinor,
            q.totals.taxTotalMinor,
            q.totals.totalMinor,
          ])
          const order = await orderOf(s, answer.orderId)
          const metadata = order.metadata as {
            shipping?: unknown
            tax?: { shippingTaxMinor?: number }
          }
          expect(metadata.shipping).toEqual({
            provider: 'native',
            optionId: option.id,
            name: option.name,
            amountMinor: option.amountMinor,
            estimatedDays: option.estimatedDays,
          })
          const orderShippingTax =
            row.tax_total_minor - sum(order.lineItems.map((l: OrderLineItem) => l.lineTaxMinor))
          expect(orderShippingTax).toBe(shippingTaxOf(q.totals))
          // metadata.tax is absent when the native tax is 0; when present it records the same shipping tax.
          expect(metadata.tax?.shippingTaxMinor ?? shippingTaxOf(q.totals)).toBe(
            shippingTaxOf(q.totals),
          )
          expect(s.intents.created.find((i) => i.id === answer.paymentIntent.id)?.amountMinor).toBe(
            row.total_minor,
          )
          expect(await settle(s, answer, row)).toBe('confirmed')
        },
      ),
      { numRuns: 20 },
    )
  })
})

describe('AC-9: no charge the caller was not shown', () => {
  // Kills: a caller that sent no total charged shipping it was never shown (the inclusive store has no tax on top,
  // so only the shipping rule refuses it), or a refusal that still writes.
  it('AC-9: on a store with a table, a paid option with no expectedTotalMinor answers 409 checkout.total_changed with quoted null and the due total, writing nothing; a free option on an inclusive store proceeds with none', async () => {
    const b = await basket(shippedWithin, [{ priceMinor: 1_200, qty: 2 }], 1_000)
    const q = await quoteData(b.shop, { shippingAddress: address, shippingOptionId: 'express' })
    expect(q.totals.shippingTotalMinor).toBe(999)
    const email = pendingEmail()
    const before = await traces(shippedWithin, b)

    const res = await placeOrder(b.shop, email, { shippingOptionId: 'express' })

    expect([res.status, errorOf(res.body).code], JSON.stringify(res.body)).toEqual([
      409,
      'checkout.total_changed',
    ])
    expect(errorOf(res.body).context).toEqual({ quoted: null, due: q.totals.totalMinor })
    expect(await ordersBy(shippedWithin, email)).toBe(0)
    expect(await traces(shippedWithin, b)).toEqual(before)

    const collect = await placeOrder(b.shop, email, { shippingOptionId: 'collect' })
    expect(collect.status, JSON.stringify(collect.body)).toBe(200)
    const row = await orderRow(shippedWithin.raw, collect.body.data!.orderId)
    expect([row.shipping_total_minor, row.total_minor]).toEqual([0, b.cart.totals.totalMinor])
  })

  it('AC-9: with no expectedTotalMinor, exclusive tax on a free option is still refused 409 with quoted null and the due total, as before shipping', async () => {
    const b = await basket(shipped, [{ priceMinor: 3_333, qty: 3 }], 1_000)
    const q = await quoteData(b.shop, { shippingAddress: address, shippingOptionId: 'collect' })
    expect(q.totals.shippingTotalMinor).toBe(0)
    const email = pendingEmail()
    const before = await traces(shipped, b)

    const res = await placeOrder(b.shop, email, { shippingOptionId: 'collect' })

    expect([res.status, errorOf(res.body).code], JSON.stringify(res.body)).toEqual([
      409,
      'checkout.total_changed',
    ])
    expect(errorOf(res.body).context).toEqual({ quoted: null, due: q.totals.totalMinor })
    expect(await traces(shipped, b)).toEqual(before)
  })

  // Kills: a refusal that cancels the shopper's pending order or its intent before it is answered.
  it('AC-9: a post with no total, or another total, against a pending order leaves that order and its intent as they were; the quoted total proceeds onto the same order', async () => {
    const b = await basket(shippedWithin, [{ priceMinor: 2_499, qty: 2 }])
    const q = await quoteData(b.shop, { shippingAddress: address, shippingOptionId: 'express' })
    const email = pendingEmail()
    const first = await placeOrder(b.shop, email, {
      shippingOptionId: 'express',
      expectedTotalMinor: q.totals.totalMinor,
    })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const placed = first.body.data!
    const cancelledBefore = shippedWithin.intents.cancelled.length

    const none = await placeOrder(b.shop, email, { shippingOptionId: 'express' })
    const other = await placeOrder(b.shop, email, {
      shippingOptionId: 'express',
      expectedTotalMinor: q.totals.totalMinor - 1,
    })

    expect([none.status, errorOf(none.body).code]).toEqual([409, 'checkout.total_changed'])
    expect(errorOf(none.body).context).toEqual({ quoted: null, due: q.totals.totalMinor })
    expect([other.status, errorOf(other.body).code]).toEqual([409, 'checkout.total_changed'])
    expect(errorOf(other.body).context).toEqual({
      quoted: q.totals.totalMinor - 1,
      due: q.totals.totalMinor,
    })
    const row = await orderRow(shippedWithin.raw, placed.orderId)
    expect([row.status, row.payment_intent_id, row.total_minor]).toEqual([
      'pending',
      placed.paymentIntent.id,
      q.totals.totalMinor,
    ])
    expect(shippedWithin.intents.cancelled.length).toBe(cancelledBefore)
    expect(await ordersBy(shippedWithin, email)).toBe(1)

    const again = await placeOrder(b.shop, email, {
      shippingOptionId: 'express',
      expectedTotalMinor: q.totals.totalMinor,
    })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data!.orderId).toBe(placed.orderId)
  })

  // Kills: an option the address is not offered placed at some other option's price.
  it('AC-9: a shippingOptionId not offered for the address answers 409 checkout.shipping_option_unavailable and writes nothing', async () => {
    const b = await basket(shippedWithin, [{ priceMinor: 1_500, qty: 1 }])
    const email = pendingEmail()
    const before = await traces(shippedWithin, b)

    const res = await placeOrder(b.shop, email, {
      shippingOptionId: 'europe',
      expectedTotalMinor: b.cart.totals.totalMinor,
    })

    expect([res.status, errorOf(res.body).code], JSON.stringify(res.body)).toEqual([
      409,
      'checkout.shipping_option_unavailable',
    ])
    expect(await ordersBy(shippedWithin, email)).toBe(0)
    expect(await traces(shippedWithin, b)).toEqual(before)
  })

  // Kills: a switch of option at the same amount reusing the first option's pending order (AC-10's defect, seen
  // from HTTP): over £50 Standard and Click and collect are both free, so the totals alone cannot tell them apart.
  it('AC-9: switching between two free options after a first attempt places a new order at the new option, not the first option’s pending one', async () => {
    const b = await basket(shippedWithin, [{ priceMinor: 6_000, qty: 1 }])
    const email = pendingEmail()
    const total = b.cart.totals.totalMinor
    const first = await placeOrder(b.shop, email, {
      shippingOptionId: 'standard',
      expectedTotalMinor: total,
    })
    expect(first.status, JSON.stringify(first.body)).toBe(200)

    const second = await placeOrder(b.shop, email, {
      shippingOptionId: 'collect',
      expectedTotalMinor: total,
    })

    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.data!.orderId).not.toBe(first.body.data!.orderId)
    const order = await orderOf(shippedWithin, second.body.data!.orderId)
    expect((order.metadata as { shipping?: { optionId?: string } }).shipping?.optionId).toBe(
      'collect',
    )
    expect(await orderRow(shippedWithin.raw, first.body.data!.orderId)).toMatchObject({
      status: 'cancelled',
    })
  })
})
