import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  Address,
  CheckoutTotalsLine,
  OrderLineItem,
  PaymentIntentParams,
} from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
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
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import {
  DESTINATIONS,
  flagOf,
  RATES,
  taxOnTop,
  taxWithin,
  UNTAXED,
  withTax,
  type Destination,
  type TaxSetup,
} from '../support/tax.js'

// Tax through a checkout over HTTP on served kernels (SQLite) with the native engine: a store that set nothing, one
// adding tax on top of its prices from a rate table, and one whose prices include it. What the order records, what is
// charged, what a caller that sent no total must have been shown before tax is added, and what the cart says of its prices.

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  totalMinor: number
  paymentIntent: { id: string; amountMinor: number }
}

interface ErrorBody {
  code: string
  context?: { quoted?: number | null; due?: number }
}

interface Intents {
  created: { id: string; amountMinor: number }[]
  cancelled: string[]
}

interface Store {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  intents: Intents
}

interface OrderRow {
  subtotal_minor: number
  discount_total_minor: number
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

async function serve(setup?: TaxSetup): Promise<Store> {
  const k = await createKernel({
    dialect: 'sqlite',
    ...(setup !== undefined && { configure: withTax(setup) }),
  })
  const served = await serveKernel(k)
  return { k, served, raw: openRaw(k.dialect, k.target), intents: watchIntents(k) }
}

/** A store that configured nothing about tax: the harness config as it was before tax existed. */
let plain: Store
/** Tax added on top of prices, from the rate table. */
let exclusive: Store
/** Prices include tax, from the same table. */
let inclusive: Store

beforeAll(async () => {
  ;[plain, exclusive, inclusive] = await Promise.all([
    serve(),
    serve({ rates: RATES }),
    serve({ rates: RATES, pricesIncludeTax: true }),
  ])
}, 60_000)

afterAll(async () => {
  for (const s of [plain, exclusive, inclusive]) {
    await s?.raw.close()
    await s?.served.stop()
  }
})

const pendingEmail = () => `buyer-${randomUUID()}+stub-pending@tax.test`

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
      : await seedPromotion(s.k, { code: uniqueCode('TAX'), kind: 'percent', percentBps: bps })
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

function checkout(
  shop: Shop,
  email: string,
  over: { expectedTotalMinor?: number; shippingAddress?: Address } = {},
) {
  const shipTo = over.shippingAddress ?? DESTINATIONS[0]!.shipTo
  return shop.call<CheckoutAnswer>('POST', '/api/checkout', {
    email,
    billingAddress: shipTo,
    shippingAddress: shipTo,
    ...(over.expectedTotalMinor !== undefined && { expectedTotalMinor: over.expectedTotalMinor }),
  })
}

function orderRow(raw: RawReader, orderId: string): Promise<OrderRow> {
  return raw.one<OrderRow>(
    'SELECT subtotal_minor, discount_total_minor, tax_total_minor, total_minor, status, payment_intent_id ' +
      'FROM orders WHERE id = ?',
    [orderId],
  )
}

/** The order's prices_include_tax column, as a second connection reads it. */
async function includesTax(raw: RawReader, orderId: string): Promise<boolean> {
  const row = await raw.one<{ flag: unknown }>(
    'SELECT prices_include_tax AS flag FROM orders WHERE id = ?',
    [orderId],
  )
  return flagOf(row.flag)
}

function orderOf(s: Store, orderId: string) {
  return s.k.store.read(async (tx) => (await s.k.repos.order.findById(tx, orderId))!)
}

const ordersBy = (s: Store, email: string) => s.raw.count('orders', 'email = ?', [email])

/** What a checkout can leave behind for these variants and this code, as a second connection reads it. */
async function traces(s: Store, b: Basket) {
  return {
    reservations: await Promise.all(
      b.seeded.map((v) => s.raw.count('inventory_reservations', 'variant_id = ?', [v.variantId])),
    ),
    stock: await Promise.all(b.seeded.map((v) => stockOf(s.raw, v.variantId))),
    redemptions:
      b.promotion === undefined
        ? 0
        : await s.raw.count('promotion_redemptions', 'promotion_id = ?', [b.promotion.id]),
    intentsCreated: s.intents.created.length,
    intentsCancelled: s.intents.cancelled.length,
  }
}

/** Each line of the cart the shopper saw, with the amount tax is due on: its subtotal less its discount. */
function discounted(cart: PricedCart): Array<CheckoutTotalsLine & { amountMinor: number }> {
  return cart.totals.lines.map((l) => ({ ...l, amountMinor: l.subtotalMinor - l.discountMinor }))
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0)

// At least 100 a unit, so every line keeps at least 10 after a code and owes at least a unit of tax at every rate in
// the table: a cart with no tax is AC-7's.
const arbLines = fc.array(
  fc.record({
    priceMinor: fc.integer({ min: 100, max: 40_000 }),
    qty: fc.integer({ min: 1, max: 4 }),
  }),
  { minLength: 1, maxLength: 3 },
)

/** No code, or a percent off below 100%, so the free-order rule never refuses it. */
const arbBps = fc.option(fc.integer({ min: 1, max: 9_000 }), { nil: null })

const arbDestination = fc.constantFrom(...DESTINATIONS)

/** Pays `row.total_minor` for the order's intent and answers the order's status after. */
async function settle(s: Store, answer: CheckoutAnswer, row: OrderRow): Promise<string> {
  const done = await s.k.services.checkout.finalize(answer.paymentIntent.id, {
    amountMinor: row.total_minor,
    currency: 'GBP',
  })
  expect(done.finalized, JSON.stringify(done)).toBe(true)
  return (await orderRow(s.raw, answer.orderId)).status
}

describe('AC-7: a store that sets nothing is unchanged', () => {
  // Kills: a store that configured nothing starting to record or charge tax.
  it('AC-7: property: with no rates, for a generated cart with and without a code, the order has no tax on its column, its lines or its metadata, prices_include_tax false, and the total, discount and charge the cart showed', async () => {
    await fc.assert(
      fc.asyncProperty(arbLines, arbBps, async (lines, bps) => {
        const b = await basket(plain, lines, bps)

        const res = await checkout(b.shop, pendingEmail())

        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const answer = res.body.data!
        const row = await orderRow(plain.raw, answer.orderId)
        expect(row.tax_total_minor).toBe(0)
        expect(row.discount_total_minor).toBe(b.cart.totals.discountTotalMinor)
        expect(row.total_minor).toBe(b.cart.totals.totalMinor)
        expect(row.total_minor).toBe(row.subtotal_minor - row.discount_total_minor)
        const order = await orderOf(plain, answer.orderId)
        expect(order.lineItems.map((l: OrderLineItem) => l.lineTaxMinor)).toEqual(
          order.lineItems.map(() => 0),
        )
        expect((order.metadata as { tax?: unknown }).tax).toBeUndefined()
        expect(
          plain.intents.created.find((i) => i.id === answer.paymentIntent.id)?.amountMinor,
        ).toBe(row.total_minor)
        expect(await includesTax(plain.raw, answer.orderId)).toBe(false)
      }),
      { numRuns: 10 },
    )
  })

  // Kills: an address with no region throwing in the native engine and refusing every checkout as a tax outage. The
  // route's schema requires a region, so the checkout service is called as code embedding the kernel calls it.
  it('AC-7: a shipping address with no region places the order with no tax, at the total the cart showed', async () => {
    const b = await basket(plain, [{ priceMinor: 1_500, qty: 2 }])
    const { region: _region, ...noRegion } = DESTINATIONS[0]!.shipTo
    const shipTo = noRegion as unknown as Address

    const placed = await plain.k.services.checkout.beginCheckout({
      cartToken: b.cart.token,
      email: pendingEmail(),
      billingAddress: shipTo,
      shippingAddress: shipTo,
    })

    const row = await orderRow(plain.raw, placed.orderId)
    expect(row.tax_total_minor).toBe(0)
    expect(row.total_minor).toBe(b.cart.totals.totalMinor)
    const order = await orderOf(plain, placed.orderId)
    expect((order.metadata as { tax?: unknown }).tax).toBeUndefined()
  })
})

describe('AC-8: tax added on top at checkout', () => {
  // Kills: tax quoted on the pre-discount amount; an intent that leaves the tax out, so finalize records amount_mismatch.
  it('AC-8: property: for a generated cart, an optional code and a destination with a rate, sending the taxed total, each line is taxed on its discounted amount, the column is their sum, the total adds it on, and the intent of that total confirms the order', async () => {
    await fc.assert(
      fc.asyncProperty(arbLines, arbBps, arbDestination, async (lines, bps, to: Destination) => {
        const b = await basket(exclusive, lines, bps)
        const taxes = new Map(
          discounted(b.cart).map((l) => [l.id, taxOnTop(l.amountMinor, to.percent)]),
        )
        const tax = sum([...taxes.values()])
        const due = b.cart.totals.subtotalMinor - b.cart.totals.discountTotalMinor + tax

        const res = await checkout(b.shop, pendingEmail(), {
          expectedTotalMinor: due,
          shippingAddress: to.shipTo,
        })

        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const answer = res.body.data!
        const row = await orderRow(exclusive.raw, answer.orderId)
        const order = await orderOf(exclusive, answer.orderId)
        for (const line of order.lineItems) {
          expect(line.lineTaxMinor, line.variantId).toBe(taxes.get(line.variantId))
          expect(line.lineTotalMinor, line.variantId).toBe(line.unitPriceMinor * line.qty)
        }
        expect(row.tax_total_minor).toBe(sum(order.lineItems.map((l) => l.lineTaxMinor)))
        expect(row.total_minor).toBe(
          row.subtotal_minor - row.discount_total_minor + row.tax_total_minor,
        )
        expect(row.total_minor).toBe(due)
        expect(await includesTax(exclusive.raw, answer.orderId)).toBe(false)
        expect(
          exclusive.intents.created.find((i) => i.id === answer.paymentIntent.id)?.amountMinor,
        ).toBe(row.total_minor)
        expect(await settle(exclusive, answer, row)).toBe('confirmed')
      }),
      { numRuns: 20 },
    )
  })
})

describe('AC-9: prices that include tax at checkout', () => {
  // Kills: an inclusive store adding tax on top of prices that already contain it.
  it('AC-9: property: with pricesIncludeTax, the total is the subtotal less the discount whatever the rate, each line’s tax is extracted from its discounted amount and within it, prices_include_tax is true, and the intent of the total confirms the order', async () => {
    await fc.assert(
      fc.asyncProperty(arbLines, arbBps, arbDestination, async (lines, bps, to: Destination) => {
        const b = await basket(inclusive, lines, bps)
        const amounts = new Map(discounted(b.cart).map((l) => [l.id, l.amountMinor]))

        const res = await checkout(b.shop, pendingEmail(), { shippingAddress: to.shipTo })

        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const answer = res.body.data!
        const row = await orderRow(inclusive.raw, answer.orderId)
        expect(row.total_minor).toBe(b.cart.totals.subtotalMinor - b.cart.totals.discountTotalMinor)
        expect(row.total_minor).toBe(row.subtotal_minor - row.discount_total_minor)
        const order = await orderOf(inclusive, answer.orderId)
        for (const line of order.lineItems) {
          const amount = amounts.get(line.variantId)!
          expect(line.lineTaxMinor, line.variantId).toBe(taxWithin(amount, to.percent))
          expect(line.lineTaxMinor, line.variantId).toBeLessThanOrEqual(amount)
        }
        expect(row.tax_total_minor).toBe(sum(order.lineItems.map((l) => l.lineTaxMinor)))
        expect(await includesTax(inclusive.raw, answer.orderId)).toBe(true)
        expect(
          inclusive.intents.created.find((i) => i.id === answer.paymentIntent.id)?.amountMinor,
        ).toBe(row.total_minor)
        expect(await settle(inclusive, answer, row)).toBe('confirmed')
      }),
      { numRuns: 20 },
    )
  })
})

describe('AC-11: no charge the caller was not shown', () => {
  const taxedDue = (b: Basket, percent: number) =>
    b.cart.totals.totalMinor + sum(discounted(b.cart).map((l) => taxOnTop(l.amountMinor, percent)))

  // Kills: a dry quote that leaves tax out, so a caller shown the untaxed total is charged the taxed one.
  it('AC-11: property: on an exclusive store, an expectedTotalMinor equal to the untaxed cart total answers 409 checkout.total_changed with quoted and due = quoted + tax, and writes no order, reservation, redemption or intent', async () => {
    await fc.assert(
      fc.asyncProperty(arbLines, arbDestination, async (lines, to: Destination) => {
        const b = await basket(exclusive, lines, 1_000)
        const quoted = b.cart.totals.totalMinor
        const due = taxedDue(b, to.percent)
        fc.pre(due > quoted)
        const email = pendingEmail()
        const before = await traces(exclusive, b)

        const res = await checkout(b.shop, email, {
          expectedTotalMinor: quoted,
          shippingAddress: to.shipTo,
        })

        expect(res.status, JSON.stringify(res.body)).toBe(409)
        const error = res.body.error as unknown as ErrorBody
        expect(error.code).toBe('checkout.total_changed')
        expect(error.context).toEqual({ quoted, due })
        expect(await ordersBy(exclusive, email)).toBe(0)
        expect(await traces(exclusive, b)).toEqual(before)
      }),
      { numRuns: 6 },
    )
  })

  it('AC-11: the untaxed total sent against a pending order leaves that order and its intent as they were; the taxed total proceeds', async () => {
    const b = await basket(exclusive, [{ priceMinor: 2_499, qty: 2 }], 1_000)
    const email = pendingEmail()
    const due = taxedDue(b, 20)
    const first = await checkout(b.shop, email, { expectedTotalMinor: due })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const placed = first.body.data!
    const cancelledBefore = exclusive.intents.cancelled.length

    const refused = await checkout(b.shop, email, { expectedTotalMinor: b.cart.totals.totalMinor })

    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect((refused.body.error as unknown as ErrorBody).context).toEqual({
      quoted: b.cart.totals.totalMinor,
      due,
    })
    const row = await orderRow(exclusive.raw, placed.orderId)
    expect([row.status, row.payment_intent_id, row.total_minor]).toEqual([
      'pending',
      placed.paymentIntent.id,
      due,
    ])
    expect(exclusive.intents.cancelled.length).toBe(cancelledBefore)
    expect(await ordersBy(exclusive, email)).toBe(1)

    const again = await checkout(b.shop, email, { expectedTotalMinor: due })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data!.orderId).toBe(placed.orderId)
  })

  // Kills: a caller that sent no total (the element, ACP, UCP today) charged tax it was never shown.
  it('AC-11: with no expectedTotalMinor, exclusive tax is refused 409 with quoted null and the due total, writing nothing; an inclusive store, and a destination with no row, proceed with none', async () => {
    const b = await basket(exclusive, [{ priceMinor: 3_333, qty: 3 }], 1_000)
    const email = pendingEmail()
    const before = await traces(exclusive, b)

    const res = await checkout(b.shop, email)

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    const error = res.body.error as unknown as ErrorBody
    expect(error.code).toBe('checkout.total_changed')
    expect(error.context).toEqual({ quoted: null, due: taxedDue(b, 20) })
    expect(await ordersBy(exclusive, email)).toBe(0)
    expect(await traces(exclusive, b)).toEqual(before)

    const within = await basket(inclusive, [{ priceMinor: 3_333, qty: 3 }], 1_000)
    const inclusiveRes = await checkout(within.shop, pendingEmail())
    expect(inclusiveRes.status, JSON.stringify(inclusiveRes.body)).toBe(200)
    expect(inclusiveRes.body.data!.totalMinor).toBe(within.cart.totals.totalMinor)

    const outside = await basket(exclusive, [{ priceMinor: 3_333, qty: 3 }], 1_000)
    const outsideRes = await checkout(outside.shop, pendingEmail(), { shippingAddress: UNTAXED })
    expect(outsideRes.status, JSON.stringify(outsideRes.body)).toBe(200)
    expect(outsideRes.body.data!.totalMinor).toBe(outside.cart.totals.totalMinor)
    const outsideRow = await orderRow(exclusive.raw, outsideRes.body.data!.orderId)
    expect(outsideRow.tax_total_minor).toBe(0)
  })
})

describe('AC-18: cart totals and the store’s flag', () => {
  // Kills: the cart and its order disagreeing on whether prices include tax.
  it('AC-18: GET /api/cart answers totals.pricesIncludeTax equal to the store’s flag and taxTotalMinor 0, with every other total the untaxed settlement’s', async () => {
    for (const [s, flag] of [
      [plain, false],
      [exclusive, false],
      [inclusive, true],
    ] as const) {
      const b = await basket(s, [{ priceMinor: 1_999, qty: 3 }], 1_500)
      const { totals } = (await readCart(b.shop)).body.data!

      expect(totals.pricesIncludeTax, `store flag ${flag}`).toBe(flag)
      expect(totals.taxTotalMinor).toBe(0)
      expect(totals.subtotalMinor).toBe(1_999 * 3)
      expect(totals.discountTotalMinor).toBe(Math.floor((1_999 * 3 * 1_500) / 10_000))
      expect(totals.totalMinor).toBe(totals.subtotalMinor - totals.discountTotalMinor)
    }
  })
})
