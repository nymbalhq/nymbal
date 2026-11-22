import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  ConfigError,
  type Address,
  type OrderLineItem,
  type PaymentIntentParams,
  type PromotionSession,
  type ShippingAdapter,
  type ShippingRate,
  type ShippingRateParams,
  type TaxQuoteParams,
} from '@nymbalhq/types'
import { settlesWithin } from '../../src/tests/settles-within.js'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  CHECKOUT_SESSION,
  acpClient,
  createBody,
  seedPool,
  withAcp,
  type AcpSession,
} from '../support/acp.js'
import { serveWithAgents, type AgentStore } from '../support/agents.js'
import {
  DEFAULT_GRAMS,
  offeredBy,
  parcelGrams,
  scriptedCarrier,
  seedWeighted,
  WAREHOUSE,
  warnLogger,
  watchTax,
  withCarrier,
  withTablePricing,
  type CarrierFault,
  type ScriptedCarrier,
  type WarnLogger,
} from '../support/carrier.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, type Kernel, type Seeded } from '../support/kernel.js'
import {
  addLine,
  putCode,
  readCart,
  scriptedEngine,
  type PricedCart,
  type Shop,
} from '../support/promotions.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import { createTestShipAdapter } from '../support/test-ship.js'
import {
  both,
  offered,
  placeOrder,
  quote,
  shippingTaxOf,
  TABLE,
  type CheckoutAnswer,
  type ErrorBody,
  type QuoteBody,
  type ShippingRow,
} from '../support/shipping.js'
import { taxOnTop, taxWithin, UNTAXED, withTax, type RateRow } from '../support/tax.js'

// Shipping priced by the carrier through a checkout over HTTP on served kernels (SQLite): the kernel's test shipping
// provider in the `custom` slot rates every cart as one parcel from the store's ship-from address, and its answer
// becomes the options a shopper chooses between and the amount the order is charged. What the quote asks the carrier
// and answers, what the order records, what the checkout does when the carrier's answer moved, is gone or never
// comes, that no store read or write waits on the carrier, and that a table store never calls it. Beside them, the
// boot refusal of a carrier store whose adapter cannot rate, and the run against EasyPost's test mode a human starts.

interface Intents {
  created: { id: string; amountMinor: number }[]
  cancelled: string[]
}

interface Store {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  carrier: ScriptedCarrier
  tax: TaxQuoteParams[]
  intents: Intents
  logger: WarnLogger
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

/** GB, CA and NY tax shipping; Germany's row exempts it; Japan has no row. */
const TAX_ROWS: RateRow[] = [
  { country: 'GB', percent: 20, taxShipping: true },
  { country: 'US', region: 'CA', percent: 7.25, taxShipping: true },
  { country: 'US', region: 'NY', percent: 8.875, taxShipping: true },
  { country: 'DE', percent: 19, taxShipping: false },
]

interface Destination {
  shipTo: Address
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

/** The scripted promotions engine's code: £1.50 off shipping. */
const SHIP_OFF = 'SHIPOFF'
const SHIP_OFF_MINOR = 150

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

async function serveCarrierStore(inclusive: boolean): Promise<Store> {
  const carrier = scriptedCarrier()
  const engine = scriptedEngine()
  engine.answer((session: PromotionSession) =>
    session.codes.includes(SHIP_OFF)
      ? {
          effects: [
            { kind: 'code_accepted', code: SHIP_OFF },
            { kind: 'shipping', amountMinor: SHIP_OFF_MINOR, label: SHIP_OFF, code: SHIP_OFF },
          ],
        }
      : { effects: [] },
  )
  const logger = warnLogger()
  const k = await createKernel({
    dialect: 'sqlite',
    logger,
    configure: both(
      withTax({ rates: TAX_ROWS, pricesIncludeTax: inclusive }),
      withCarrier(),
      (config: NymbalConfig) =>
        ({
          ...config,
          commerce: {
            ...config.commerce,
            promotions: { provider: 'custom', onUnavailable: 'proceed' },
          },
        }) as NymbalConfig,
    ),
    appOptions: { adapters: { shipping: carrier.adapter, promotions: engine.adapter } },
  })
  const served = await serveKernel(k)
  return {
    k,
    served,
    raw: openRaw(k.dialect, k.target),
    carrier,
    tax: watchTax(k),
    intents: watchIntents(k),
    logger,
    inclusive,
  }
}

/** Tax on top of prices. */
let onTop: Store
/** Prices include tax. */
let within: Store

beforeAll(async () => {
  ;[onTop, within] = await Promise.all([serveCarrierStore(false), serveCarrierStore(true)])
}, 60_000)

afterAll(async () => {
  for (const s of [onTop, within]) {
    s?.carrier.recover()
    await s?.raw.close()
    await s?.served.stop()
  }
})

const pendingEmail = () => `buyer-${randomUUID()}+stub-pending@carrier.test`

interface Line {
  priceMinor: number
  qty: number
  weightGrams: number | null
}

interface Basket {
  shop: Shop
  seeded: Array<Seeded & { weightGrams: number | null }>
  lines: readonly Line[]
  cart: PricedCart
}

/** A shopper of its own with these lines and, when asked, the shipping code. */
async function basket(s: Store, lines: readonly Line[], withCode = false): Promise<Basket> {
  // A raw read waits on the store's lock with the thread asleep: the last command's pass must be done first.
  await s.k.app.relay.drain()
  const seeded = await Promise.all(lines.map((l) => seedWeighted(s.k, l)))
  const shop = await primedShopper(s.served.baseUrl)
  expect((await readCart(shop)).status).toBe(200)
  for (const [i, v] of seeded.entries()) {
    const added = await addLine(shop, v, lines[i]!.qty)
    expect(added.status, JSON.stringify(added.body)).toBe(200)
  }
  let cart = (await readCart(shop)).body.data!
  if (withCode) {
    const coded = await putCode(shop, SHIP_OFF)
    expect(coded.status, JSON.stringify(coded.body)).toBe(200)
    cart = coded.body.data!
  }
  return { shop, seeded, lines, cart }
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

/** What a checkout or a quote can leave behind for this basket, as a second connection reads it. */
async function traces(s: Store, b: Basket) {
  return {
    orders: await s.raw.count('orders'),
    reservations: await Promise.all(
      b.seeded.map((v) => s.raw.count('inventory_reservations', 'variant_id = ?', [v.variantId])),
    ),
    redemptions: await s.raw.count('promotion_redemptions'),
    intentsCreated: s.intents.created.length,
    intentsCancelled: s.intents.cancelled.length,
    cart: await s.raw.one<{ updated_at: unknown; expires_at: unknown; promotions: unknown }>(
      'SELECT updated_at, expires_at, promotions FROM carts WHERE token = ?',
      [b.cart.token],
    ),
  }
}

const errorOf = (body: { error?: unknown }): Partial<ErrorBody> =>
  (body.error ?? {}) as Partial<ErrorBody>

async function quoteData(shop: Shop, body: Parameters<typeof quote>[1]): Promise<QuoteBody> {
  const res = await quote(shop, body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0)

/** test-ship's price for a service and a parcel: 300 + ceil(grams / 100) × (1 for standard, 2 for express). */
const testShipAmount = (service: 'standard' | 'express', grams: number): number =>
  300 + Math.ceil(grams / 100) * (service === 'standard' ? 1 : 2)

const STANDARD_ID = 'test_ship-standard'
const EXPRESS_ID = 'test_ship-express'

/** The totals equations every quote and order satisfies. */
function expectTotalsHold(totals: QuoteBody['totals'], what: string): void {
  expect(totals.totalMinor, `${what}: total`).toBe(
    totals.subtotalMinor -
      totals.discountTotalMinor +
      totals.shippingTotalMinor +
      (totals.pricesIncludeTax ? 0 : totals.taxTotalMinor),
  )
  expect(totals.discountTotalMinor, `${what}: discount`).toBe(
    sum(totals.lines.map((l) => l.discountMinor)) + totals.shippingDiscountMinor,
  )
}

/** A first checkout at the quote's option and total, left pending (its intent set), as a Stripe order is. */
async function pendingAt(s: Store, b: Basket, optionId: string) {
  const q = await quoteData(b.shop, { shippingAddress: address, shippingOptionId: optionId })
  const email = pendingEmail()
  const placed = await placeOrder(b.shop, email, {
    shippingOptionId: optionId,
    expectedTotalMinor: q.totals.totalMinor,
  })
  expect(placed.status, JSON.stringify(placed.body)).toBe(200)
  return { q, email, placed: placed.body.data! }
}

const LINES: Line[] = [
  { priceMinor: 1_250, qty: 2, weightGrams: null },
  { priceMinor: 999, qty: 3, weightGrams: 420 },
  { priceMinor: 500, qty: 1, weightGrams: 0 },
]

describe('AC-6: POST /api/checkout/quote on a carrier store', () => {
  // Kills: the kernel rating from the wrong address or to another, a parcel weighed without the default, the zero
  // weight or the quantities, options taken from the provider's per-call ids, or a second quote offering options the
  // first did not name.
  it('AC-6: each quote makes one rate call from store.shipFrom to the address for the cart’s parcel, and answers the options of what the carrier answered; a second quote answers the same ids and amounts though every rate id is new', async () => {
    const b = await basket(onTop, LINES)
    const fromCall = onTop.carrier.calls.length
    const fromAnswer = onTop.carrier.answers.length

    const first = await quoteData(b.shop, { shippingAddress: address })
    const second = await quoteData(b.shop, { shippingAddress: address })

    const grams = parcelGrams(LINES)
    expect(grams).toBe(2 * DEFAULT_GRAMS + 3 * 420)
    const asked: ShippingRateParams = {
      from: WAREHOUSE,
      to: address,
      parcel: { weightGrams: grams },
    }
    expect(onTop.carrier.calls.slice(fromCall)).toEqual([asked, asked])
    const [answerA, answerB] = onTop.carrier.answers.slice(fromAnswer) as [
      ShippingRate[],
      ShippingRate[],
    ]
    expect(first.options).toEqual(offeredBy(answerA).map((o) => o.option))
    expect(first.options.map((o) => o.id)).toEqual([STANDARD_ID, EXPRESS_ID])
    expect(first.shippingOptionId).toBe(first.options[0]!.id)
    expect(second.options).toEqual(first.options)
    expect(answerB.filter((r) => answerA.some((a) => a.id === r.id))).toEqual([])
  })

  // Kills: a carrier amount entering the totals other than as the chosen option's, the shipping discount or the
  // shipping tax lost on a carrier store, or an option the caller chose ignored.
  it('AC-6: every offered id sent back as shippingOptionId is chosen, its amount is the totals’ shipping, the totals equations hold, and GB’s 20% is taxed on the shipping less its discount', async () => {
    for (const withCode of [false, true]) {
      const b = await basket(onTop, LINES, withCode)
      const offeredOptions = (await quoteData(b.shop, { shippingAddress: address })).options
      expect(offeredOptions.map((o) => o.id)).toEqual([STANDARD_ID, EXPRESS_ID])

      for (const option of offeredOptions) {
        const what = `${option.id}${withCode ? ' with the code' : ''}`
        const q = await quoteData(b.shop, { shippingAddress: address, shippingOptionId: option.id })

        expect(q.shippingOptionId, what).toBe(option.id)
        expect(q.options, what).toEqual(offeredOptions)
        expect(q.totals.shippingTotalMinor, what).toBe(option.amountMinor)
        expect(q.totals.shippingDiscountMinor, what).toBe(withCode ? SHIP_OFF_MINOR : 0)
        expectTotalsHold(q.totals, what)
        expect(shippingTaxOf(q.totals), what).toBe(
          taxOnTop(q.totals.shippingTotalMinor - q.totals.shippingDiscountMinor, 20),
        )
      }
    }
  })

  // Kills: a quote on a carrier store that reserves stock, creates an intent or an order, or touches the cart.
  it('AC-6: quoting every option, with a code, and an id not offered, writes nothing: no order, reservation, redemption or intent, and the cart does not move', async () => {
    const b = await basket(onTop, LINES, true)
    const before = await traces(onTop, b)

    const options = (await quoteData(b.shop, { shippingAddress: address })).options
    for (const option of options) {
      await quote(b.shop, { shippingAddress: address, shippingOptionId: option.id })
    }
    const refused = await quote(b.shop, { shippingAddress: address, shippingOptionId: 'standard' })

    expect([refused.status, errorOf(refused.body).code]).toEqual([
      409,
      'checkout.shipping_option_unavailable',
    ])
    expect(await traces(onTop, b)).toEqual(before)
  })
})

// At least 100 a unit; weights none or 1 g to 5 kg.
const arbLines = fc.array(
  fc.record({
    priceMinor: fc.integer({ min: 100, max: 40_000 }),
    qty: fc.integer({ min: 1, max: 4 }),
    weightGrams: fc.option(fc.integer({ min: 1, max: 5_000 }), { nil: null }),
  }),
  { minLength: 1, maxLength: 3 },
)

describe('AC-7: the quote is the charge, carrier edition', () => {
  // Kills: place pricing the carrier differently from the quote, rating twice per place, recording a shipping amount
  // other than the option's, or never telling the tax engine that shipping was charged.
  it('AC-7: property: for a generated cart, code, destination, flag and offered carrier option, checking out at the quote’s option and total writes the quote’s columns, the option, carrier and service in metadata.shipping, asks the tax engine with shipping less its discount, rates once, and the intent of the total confirms the order', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLines,
        fc.boolean(),
        fc.constantFrom(...DESTINATIONS),
        fc.boolean(),
        fc.nat({ max: 10 }),
        async (lines, withCode, to: Destination, inclusive, pick) => {
          const s = inclusive ? within : onTop
          const b = await basket(s, lines, withCode)
          const fromAnswer = s.carrier.answers.length
          const options = (await quoteData(b.shop, { shippingAddress: to.shipTo })).options
          expect(s.carrier.answers.length - fromAnswer, 'rate calls by the quote').toBe(1)
          const offers = offeredBy(s.carrier.answers[fromAnswer]!)
          const offer = offers[pick % offers.length]!
          const option = offer.option
          expect(options).toEqual(offers.map((o) => o.option))
          expect(option.amountMinor).toBe(
            testShipAmount(offer.service as 'standard', parcelGrams(lines)),
          )

          const fromTax = s.tax.length
          const q = await quoteData(b.shop, {
            shippingAddress: to.shipTo,
            shippingOptionId: option.id,
          })
          const quoteTax = s.tax.slice(fromTax)
          const net = q.totals.shippingTotalMinor - q.totals.shippingDiscountMinor
          expect(q.totals.shippingTotalMinor).toBe(option.amountMinor)
          expect(quoteTax.map((c) => c.shipping)).toEqual([{ amountMinor: net }])
          const taxOf = inclusive ? taxWithin : taxOnTop
          expect(shippingTaxOf(q.totals)).toBe(to.taxShipping ? taxOf(net, to.percent) : 0)

          const fromCall = s.carrier.calls.length
          const fromPlaceTax = s.tax.length
          const res = await placeOrder(b.shop, pendingEmail(), {
            shippingAddress: to.shipTo,
            shippingOptionId: option.id,
            expectedTotalMinor: q.totals.totalMinor,
          })

          expect(res.status, JSON.stringify(res.body)).toBe(200)
          expect(s.carrier.calls.length - fromCall, 'rate calls by the place').toBe(1)
          const placeTax = s.tax.slice(fromPlaceTax)
          expect(placeTax.map((c) => c.shipping)).toEqual(
            placeTax.map(() => ({ amountMinor: net })),
          )
          expect(placeTax.length).toBe(quoteTax.length)
          const answer: CheckoutAnswer = res.body.data!
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
          const shipping = (order.metadata as { shipping?: { amountMinor?: number } }).shipping
          expect(shipping).toEqual({
            provider: 'test-ship',
            optionId: option.id,
            name: option.name,
            amountMinor: option.amountMinor,
            estimatedDays: option.estimatedDays,
            carrier: offer.carrier,
            service: offer.service,
          })
          expect(row.shipping_total_minor).toBe(shipping?.amountMinor)
          const orderShippingTax =
            row.tax_total_minor - sum(order.lineItems.map((l: OrderLineItem) => l.lineTaxMinor))
          expect(orderShippingTax).toBe(shippingTaxOf(q.totals))
          expect(s.intents.created.find((i) => i.id === answer.paymentIntent.id)?.amountMinor).toBe(
            row.total_minor,
          )
          const done = await s.k.services.checkout.finalize(answer.paymentIntent.id, {
            amountMinor: row.total_minor,
            currency: 'GBP',
          })
          expect(done.finalized, JSON.stringify(done)).toBe(true)
          expect((await orderRow(s.raw, answer.orderId)).status).toBe('confirmed')
        },
      ),
      { numRuns: 10 },
    )
  })
})

describe('AC-8: the carrier rated again at place', () => {
  // Kills: a shopper charged a carrier price they were not shown, or a refusal that cancels their pending order.
  it('AC-8: when the chosen option’s amount moved since the quote, the place answers 409 checkout.total_changed with the quoted total and the due one a fresh quote gives, writing nothing and leaving the pending order and its intent as they were', async () => {
    const b = await basket(onTop, LINES)
    const { q, email, placed } = await pendingAt(onTop, b, EXPRESS_ID)
    const before = await traces(onTop, b)
    onTop.carrier.move('express', 250)
    try {
      const res = await placeOrder(b.shop, email, {
        shippingOptionId: EXPRESS_ID,
        expectedTotalMinor: q.totals.totalMinor,
      })
      const fresh = await quoteData(b.shop, {
        shippingAddress: address,
        shippingOptionId: EXPRESS_ID,
      })

      expect([res.status, errorOf(res.body).code], JSON.stringify(res.body)).toEqual([
        409,
        'checkout.total_changed',
      ])
      expect(errorOf(res.body).context).toEqual({
        quoted: q.totals.totalMinor,
        due: fresh.totals.totalMinor,
      })
      expect(fresh.totals.shippingTotalMinor - q.totals.shippingTotalMinor).toBe(250)
      expect(await traces(onTop, b)).toEqual(before)
      const row = await orderRow(onTop.raw, placed.orderId)
      expect([row.status, row.payment_intent_id, row.total_minor]).toEqual([
        'pending',
        placed.paymentIntent.id,
        q.totals.totalMinor,
      ])
    } finally {
      onTop.carrier.recover()
    }
  })

  // Kills: an option the carrier no longer offers placed at a stale price.
  it('AC-8: when the chosen option is no longer answered, the place answers 409 checkout.shipping_option_unavailable with the options now offered, writing nothing and leaving the pending order as it was', async () => {
    const b = await basket(onTop, LINES)
    const { q, email, placed } = await pendingAt(onTop, b, EXPRESS_ID)
    const before = await traces(onTop, b)
    onTop.carrier.drop('express')
    try {
      const fromAnswer = onTop.carrier.answers.length
      const res = await placeOrder(b.shop, email, {
        shippingOptionId: EXPRESS_ID,
        expectedTotalMinor: q.totals.totalMinor,
      })

      expect([res.status, errorOf(res.body).code], JSON.stringify(res.body)).toEqual([
        409,
        'checkout.shipping_option_unavailable',
      ])
      const now = offeredBy(onTop.carrier.answers[fromAnswer]!).map((o) => o.option)
      expect(now.map((o) => o.id)).toEqual([STANDARD_ID])
      expect(errorOf(res.body).context?.['options']).toEqual(now)
      expect(await traces(onTop, b)).toEqual(before)
      const row = await orderRow(onTop.raw, placed.orderId)
      expect([row.status, row.payment_intent_id]).toEqual(['pending', placed.paymentIntent.id])
    } finally {
      onTop.carrier.recover()
    }
  })

  // Kills: a carrier answer with nothing the store can charge (no rates, or none in its currency) priced at 0 or at a
  // USD amount read as pence.
  it.each([
    ['answers no rates', (c: ScriptedCarrier) => c.answerNothing()],
    ['answers only in USD', (c: ScriptedCarrier) => c.answerIn('USD')],
  ] as const)(
    'AC-8: when the carrier %s, the quote and the place answer 422 checkout.no_shipping, writing nothing and leaving the pending order as it was',
    async (_what, script) => {
      const b = await basket(onTop, LINES)
      const { q, email, placed } = await pendingAt(onTop, b, STANDARD_ID)
      const before = await traces(onTop, b)
      script(onTop.carrier)
      try {
        const quoted = await quote(b.shop, { shippingAddress: address })
        const res = await placeOrder(b.shop, email, {
          shippingOptionId: STANDARD_ID,
          expectedTotalMinor: q.totals.totalMinor,
        })

        expect([quoted.status, errorOf(quoted.body).code], JSON.stringify(quoted.body)).toEqual([
          422,
          'checkout.no_shipping',
        ])
        expect([res.status, errorOf(res.body).code], JSON.stringify(res.body)).toEqual([
          422,
          'checkout.no_shipping',
        ])
        expect(await traces(onTop, b)).toEqual(before)
        const row = await orderRow(onTop.raw, placed.orderId)
        expect([row.status, row.payment_intent_id]).toEqual(['pending', placed.paymentIntent.id])
      } finally {
        onTop.carrier.recover()
      }
    },
  )
})

describe('AC-9: no guessed shipping price', () => {
  /** The warns logged since `from` that name the carrier's provider. */
  const naming = (s: Store, from: number) =>
    s.logger.warns.slice(from).filter((line) => line.includes(s.carrier.providerName))

  // Kills: an outage priced at 0, at a table amount or at the part of the answer that looked valid, or a refusal the
  // operator never hears of.
  it.each([
    ['rejects', 'throws'],
    ['answers something not an array', 'not-array'],
    ['answers a fractional amount', 'fractional'],
    ['answers a negative amount', 'negative'],
    ['answers a currency that is not three letters', 'currency'],
  ] as Array<[string, CarrierFault]>)(
    'AC-9: when the carrier %s, the quote and the place answer 503 checkout.shipping_unavailable, each with one warn naming the provider, writing nothing and leaving the pending order as it was',
    async (_what, fault) => {
      const b = await basket(onTop, LINES)
      const { q, email, placed } = await pendingAt(onTop, b, STANDARD_ID)
      const before = await traces(onTop, b)
      onTop.carrier.fail(fault)
      try {
        const warnsBeforeQuote = onTop.logger.warns.length
        const quoted = await quote(b.shop, { shippingAddress: address })
        const quoteWarns = naming(onTop, warnsBeforeQuote)
        const warnsBeforePlace = onTop.logger.warns.length
        const res = await placeOrder(b.shop, email, {
          shippingOptionId: STANDARD_ID,
          expectedTotalMinor: q.totals.totalMinor,
        })
        const placeWarns = naming(onTop, warnsBeforePlace)

        expect([quoted.status, errorOf(quoted.body).code], JSON.stringify(quoted.body)).toEqual([
          503,
          'checkout.shipping_unavailable',
        ])
        expect([res.status, errorOf(res.body).code], JSON.stringify(res.body)).toEqual([
          503,
          'checkout.shipping_unavailable',
        ])
        expect(quoteWarns.length, quoteWarns.join('\n')).toBe(1)
        expect(placeWarns.length, placeWarns.join('\n')).toBe(1)
        expect(await traces(onTop, b)).toEqual(before)
        const row = await orderRow(onTop.raw, placed.orderId)
        expect([row.status, row.payment_intent_id]).toEqual(['pending', placed.paymentIntent.id])
      } finally {
        onTop.carrier.recover()
      }
    },
  )
})

describe('AC-10: no store read or write waits on the carrier', () => {
  /** Long enough for a cart write on a loaded machine; far shorter than the kernel's 5 s bound on the carrier. */
  const ANSWER_MS = 2_500

  /** A shopper of its own, CSRF primed and its cart not yet made, ready to add a line. */
  async function otherShopper(s: Store) {
    const seeded = await seedWeighted(s.k, { priceMinor: 700, weightGrams: 100 })
    const shop = await primedShopper(s.served.baseUrl)
    return { shop, seeded }
  }

  // Kills: a rate call made inside a transaction or a store read, so on SQLite every read and write in the store
  // waits on the carrier for as long as it takes.
  it('AC-10: while the quote’s rate call is held, a cart write on another cart answers 200 before it is released, and the held quote then answers 200', async () => {
    const b = await basket(onTop, LINES)
    const other = await otherShopper(onTop)
    const held = onTop.carrier.holdNext()
    try {
      const quoting = quote(b.shop, { shippingAddress: address })

      expect(await settlesWithin(held.started, ANSWER_MS), 'the quote’s rate call').toBe('resolved')
      const adding = addLine(other.shop, other.seeded, 1)
      expect(await settlesWithin(adding, ANSWER_MS), 'the other cart’s write').toBe('resolved')
      expect((await adding).status).toBe(200)

      held.release()
      const quoted = await quoting
      expect(quoted.status, JSON.stringify(quoted.body)).toBe(200)
    } finally {
      onTop.carrier.recover()
    }
  })

  it('AC-10: while the checkout’s rate call is held, a cart write on another cart answers 200 before it is released, and the held checkout then places', async () => {
    const b = await basket(onTop, LINES)
    const q = await quoteData(b.shop, { shippingAddress: address })
    const other = await otherShopper(onTop)
    const held = onTop.carrier.holdNext()
    try {
      const placing = placeOrder(b.shop, pendingEmail(), {
        shippingOptionId: q.shippingOptionId,
        expectedTotalMinor: q.totals.totalMinor,
      })

      expect(await settlesWithin(held.started, ANSWER_MS), 'the checkout’s rate call').toBe(
        'resolved',
      )
      const adding = addLine(other.shop, other.seeded, 1)
      expect(await settlesWithin(adding, ANSWER_MS), 'the other cart’s write').toBe('resolved')
      expect((await adding).status).toBe(200)

      held.release()
      const placed = await placing
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      const row = await orderRow(onTop.raw, placed.body.data!.orderId)
      expect(row.total_minor).toBe(q.totals.totalMinor)
    } finally {
      onTop.carrier.recover()
    }
  })

  // Kills: an order charged shipping weighed for lines other than the ones it orders, when a line lands on the cart
  // between the checkout's rating and its lock.
  it('AC-10: a line of at least 100 g added to the checkout’s own cart while its rate call is held refuses the place 409 checkout.total_changed due a fresh quote’s total, and a resubmit at that total places at the heavier parcel’s shipping', async () => {
    const b = await basket(onTop, LINES)
    const q = await quoteData(b.shop, { shippingAddress: address, shippingOptionId: STANDARD_ID })
    const heavy = await seedWeighted(onTop.k, { priceMinor: 800, weightGrams: 1_250 })
    const email = pendingEmail()
    const held = onTop.carrier.holdNext()
    let res!: Awaited<ReturnType<typeof placeOrder>>
    try {
      const placing = placeOrder(b.shop, email, {
        shippingOptionId: STANDARD_ID,
        expectedTotalMinor: q.totals.totalMinor,
      })
      expect(await settlesWithin(held.started, ANSWER_MS), 'the checkout’s rate call').toBe(
        'resolved',
      )
      const adding = addLine(b.shop, heavy, 1)
      expect(await settlesWithin(adding, ANSWER_MS), 'the line added to the cart').toBe('resolved')
      expect((await adding).status).toBe(200)
      held.release()
      res = await placing
    } finally {
      onTop.carrier.recover()
    }

    const fresh = await quoteData(b.shop, {
      shippingAddress: address,
      shippingOptionId: STANDARD_ID,
    })
    const heavier = parcelGrams([...LINES, { weightGrams: 1_250, qty: 1 }])
    expect(fresh.totals.shippingTotalMinor).toBe(testShipAmount('standard', heavier))
    expect([res.status, errorOf(res.body).code], JSON.stringify(res.body)).toEqual([
      409,
      'checkout.total_changed',
    ])
    expect(errorOf(res.body).context).toEqual({
      quoted: q.totals.totalMinor,
      due: fresh.totals.totalMinor,
    })

    const again = await placeOrder(b.shop, email, {
      shippingOptionId: STANDARD_ID,
      expectedTotalMinor: fresh.totals.totalMinor,
    })

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    const row = await orderRow(onTop.raw, again.body.data!.orderId)
    expect(row.shipping_total_minor).toBe(testShipAmount('standard', heavier))
    expect(row.shipping_total_minor).toBeGreaterThan(q.totals.shippingTotalMinor)
    expect(row.total_minor).toBe(fresh.totals.totalMinor)
  })
})

describe('AC-11: table and free stores never call the carrier', () => {
  interface TableStore {
    store: AgentStore
    carrier: ScriptedCarrier
    rows: readonly ShippingRow[]
  }
  let stores: TableStore[] = []

  beforeAll(async () => {
    stores = await Promise.all(
      [TABLE, []].map(async (rows: readonly ShippingRow[]) => {
        const carrier = scriptedCarrier()
        const kernel = await createKernel({
          dialect: 'sqlite',
          configure: both(withAcp, withTablePricing(rows)),
          appOptions: { adapters: { shipping: carrier.adapter } },
        })
        return { store: await serveWithAgents(kernel), carrier, rows }
      }),
    )
  }, 60_000)

  afterAll(async () => {
    for (const s of stores) await s.store.stop()
  })

  // Kills: a store that keyed a carrier for tracking (all three words) starting to charge its rates, or a table
  // store calling the carrier at all. Passes before the change by design: it guards table and free stores from it.
  it('AC-11: with pricing table, with and without rows, and an adapter that rates, the quote offers the table’s rows (or the one free standard option), the order is placed at the quoted total, an ACP session is priced, and no rate call is made', async () => {
    for (const s of stores) {
      const what = s.rows.length === 0 ? 'no rows' : 'the table'
      const [v] = await seedPool(s.store, [{ priceMinor: 1_800, stock: 1_000 }])
      const shop = await primedShopper(s.store.baseUrl)
      expect((await readCart(shop)).status).toBe(200)
      const added = await shop.call('POST', '/api/cart/items', { variantId: v!.variantId, qty: 2 })
      expect(added.status, JSON.stringify(added.body)).toBe(200)
      const cart = (await readCart(shop)).body.data!

      const q = await quoteData(shop, { shippingAddress: address })
      const placed = await placeOrder(shop, pendingEmail(), {
        shippingOptionId: q.shippingOptionId,
        expectedTotalMinor: q.totals.totalMinor,
      })
      const agent = acpClient(s.store.baseUrl)
      const session = await agent.create(createBody([{ variantId: v!.variantId, quantity: 1 }]))
      const read = await agent.get(session.body.id)

      expect(q.options, what).toEqual(offered(s.rows, 'GB', cart.totals.subtotalMinor))
      expect(placed.status, `${what}: ${JSON.stringify(placed.body)}`).toBe(200)
      expect(placed.body.data!.totalMinor, what).toBe(q.totals.totalMinor)
      expect(session.status, `${what}: ${JSON.stringify(session.body)}`).toBe(201)
      expect(validateAcp(CHECKOUT_SESSION, read.body), what).toEqual([])
      expect(
        ((read.body as AcpSession).fulfillment_options as Array<{ id: string }>).map((o) => o.id),
        what,
      ).toEqual(offered(s.rows, 'GB', v!.priceMinor).map((o) => o.id))
      expect(s.carrier.calls, what).toEqual([])
    }
  })
})

describe('AC-2: a carrier store needs an adapter that rates', () => {
  /** What createApp does with this setup: boots (and is closed again) or refuses with an error. */
  async function boot(
    configure: (config: NymbalConfig) => NymbalConfig,
    shipping?: ShippingAdapter,
  ): Promise<unknown> {
    try {
      const k = await createKernel({
        dialect: 'sqlite',
        configure,
        ...(shipping !== undefined && { appOptions: { adapters: { shipping } } }),
      })
      await k.close()
      return 'booted'
    } catch (err) {
      return err
    }
  }

  // Kills: a carrier store whose adapter cannot rate booting, then refusing every checkout or pricing every order at
  // the free standard option.
  it('AC-2: createApp refuses carrier pricing on EasyPost with no apiKey, on native and on test-ship with no words, with ConfigError config.shipping_cannot_rate naming the provider; test-ship with its three words boots', async () => {
    const refusals = [
      [await boot(carrierOn('easypost', { webhookSecret: 'whsec_carrier' })), /easypost/i],
      [await boot(carrierOn('native')), /native/],
      [await boot(withCarrier(), createTestShipAdapter({ words: [] })), /custom|test-ship/],
    ] as const

    for (const [refused, provider] of refusals) {
      expect(refused, String(refused)).toBeInstanceOf(ConfigError)
      expect((refused as ConfigError).code).toBe('config.shipping_cannot_rate')
      expect((refused as Error).message).toMatch(provider)
    }
    expect(await boot(withCarrier(), scriptedCarrier().adapter)).toBe('booted')
  })

  // Kills: a config edited after parsing to carrier pricing with no parcel to rate booting without the carrier and
  // charging the free standard option.
  it('AC-2: createApp refuses an unparsed carrier config with no store.shipFrom or no defaultWeightGrams, with ConfigError config.shipping_cannot_rate naming the missing field, even on an adapter that rates', async () => {
    const noShipFrom = (config: NymbalConfig): NymbalConfig => {
      const priced = withCarrier()(config)
      const { shipFrom: _dropped, ...store } = priced.store
      return { ...priced, store }
    }
    const noWeight = (config: NymbalConfig): NymbalConfig => {
      const priced = withCarrier()(config)
      const { defaultWeightGrams: _dropped, ...shipping } = priced.commerce.shipping
      return { ...priced, commerce: { ...priced.commerce, shipping } }
    }
    const refusals = [
      [await boot(noShipFrom, scriptedCarrier().adapter), /store\.shipFrom/],
      [await boot(noWeight, scriptedCarrier().adapter), /defaultWeightGrams/],
    ] as const

    for (const [refused, field] of refusals) {
      expect(refused, String(refused)).toBeInstanceOf(ConfigError)
      expect((refused as ConfigError).code).toBe('config.shipping_cannot_rate')
      expect((refused as Error).message).toMatch(field)
    }
  })
})

/** Carrier pricing on a built-in provider (native, or EasyPost with this block's config). */
function carrierOn(
  provider: 'native' | 'easypost',
  providerConfig?: Record<string, unknown>,
  opts: Parameters<typeof withCarrier>[0] = {},
): (config: NymbalConfig) => NymbalConfig {
  return (config) => {
    const priced = withCarrier(opts)(config)
    return {
      ...priced,
      commerce: {
        ...priced.commerce,
        shipping: {
          ...priced.commerce.shipping,
          provider,
          ...(providerConfig !== undefined && { config: providerConfig }),
        },
      },
    }
  }
}

// The run against EasyPost's test mode, the human's, once before a merge: skipped without the key. Not a regression
// test: what it shows is how the kernel reads EasyPost (service names, currency, weight units) and how long a rate
// call takes against the 5 s bound.
const liveKey = process.env['EASYPOST_TEST_API_KEY'] ?? ''

describe.runIf(liveKey !== '')(
  'AC-15: EasyPost test mode (EASYPOST_TEST_API_KEY; skipped without it)',
  () => {
    const SAN_FRANCISCO: Address = {
      firstName: 'Nymbal',
      lastName: 'Warehouse',
      company: 'Nymbal Contract',
      addressLine1: '417 Montgomery Street',
      addressLine2: 'Floor 5',
      city: 'San Francisco',
      region: 'CA',
      postalCode: '94104',
      country: 'US',
      phone: '4155559999',
    }
    const REDONDO_BEACH: Address = {
      firstName: 'Dr Steve',
      lastName: 'Brule',
      addressLine1: '179 N Harbor Dr',
      city: 'Redondo Beach',
      region: 'CA',
      postalCode: '90277',
      country: 'US',
      phone: '3105551234',
    }

    let live: ServedKernel
    const latencies: number[] = []

    beforeAll(async () => {
      const k = await createKernel({
        dialect: 'sqlite',
        configure: (config) =>
          carrierOn(
            'easypost',
            { apiKey: liveKey, webhookSecret: 'whsec_live_carrier' },
            { shipFrom: SAN_FRANCISCO, currency: 'USD' },
          )({
            ...config,
            store: { ...config.store, locale: 'en-US', timezone: 'America/Los_Angeles' },
          }),
      })
      // The store's own EasyPost adapter, built from the config, timed on every rate call the checkout makes.
      const easypost = k.app.adapters.shipping
      const rate = easypost.rate!.bind(easypost)
      easypost.rate = async (params: ShippingRateParams) => {
        const started = performance.now()
        try {
          return await rate(params)
        } finally {
          const ms = Math.round(performance.now() - started)
          latencies.push(ms)
          process.stdout.write(`EasyPost rate call: ${ms} ms\n`)
        }
      }
      live = await serveKernel(k)
    }, 60_000)

    afterAll(async () => {
      process.stdout.write(`EasyPost rate call latencies (ms): ${latencies.join(', ')}\n`)
      await live?.stop()
    })

    it('AC-15: a USD cart quoted twice answers the same option ids, and placing at the first quote’s option and total charges the option’s amount, or is refused total_changed and then places at the re-quoted total', async () => {
      const seeded = await seedWeighted(live.kernel, { priceMinor: 2_500, weightGrams: 700 })
      const shop = await primedShopper(live.baseUrl)
      expect((await addLine(shop, seeded, 1)).status).toBe(200)

      const first = await quoteData(shop, { shippingAddress: REDONDO_BEACH })
      const second = await quoteData(shop, { shippingAddress: REDONDO_BEACH })
      expect(second.options.map((o) => o.id)).toEqual(first.options.map((o) => o.id))
      const option = first.options[0]!

      const email = `live-${randomUUID()}+stub-pending@carrier.test`
      const firstTry = await placeOrder(shop, email, {
        shippingAddress: REDONDO_BEACH,
        shippingOptionId: option.id,
        expectedTotalMinor: first.totals.totalMinor,
      })
      // The carrier may have moved its price between the quote and the place: then the place is refused once.
      const refused = firstTry.status === 409 ? errorOf(firstTry.body).code : undefined
      expect([undefined, 'checkout.total_changed']).toContain(refused)
      const requoted =
        refused === undefined
          ? undefined
          : await quoteData(shop, { shippingAddress: REDONDO_BEACH, shippingOptionId: option.id })
      const placed =
        requoted === undefined
          ? firstTry
          : await placeOrder(shop, email, {
              shippingAddress: REDONDO_BEACH,
              shippingOptionId: option.id,
              expectedTotalMinor: requoted.totals.totalMinor,
            })
      const charged = requoted?.totals.shippingTotalMinor ?? option.amountMinor

      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      const order = await live.kernel.services.order.getById(placed.body.data!.orderId)
      expect(order.shippingTotalMinor).toBe(charged)
    }, 60_000)
  },
)
