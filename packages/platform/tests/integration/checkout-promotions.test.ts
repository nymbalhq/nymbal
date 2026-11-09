import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  type Address,
  type CheckoutTotalsLine,
  type OrderLineItem,
  type PaymentIntentParams,
  type PromotionEffect,
} from '@nymbalhq/types'
import { createCartService } from '../../src/services/cart-service.js'
import { createCheckoutService } from '../../src/services/checkout-service.js'
import { settleTotals } from '../../src/services/totals.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { adminClient } from '../support/money.js'
import {
  acceptFirstCode,
  addLine,
  putCode,
  readCart,
  scriptedEngine,
  seedPromotion,
  uniqueCode,
  updatePromotion,
  type PricedCart,
  type PromotionSeed,
  type ScriptedEngine,
  type SeededPromotion,
  type Shop,
} from '../support/promotions.js'
import { openRaw, stockOf, writeRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import { historyNotes } from '../support/webhooks.js'

// A discount through a checkout over HTTP on a served kernel (SQLite): the order's columns, the amount charged, when a
// pending order is reused, and what the engine's refusal or outage does to any of it. Parallel checkouts on one code
// are the shared race suite (support/suites/promotion-race.ts).

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  totalMinor: number
  currency: string
  paymentIntent: { id: string; amountMinor: number }
}

interface ErrorBody {
  code: string
  context?: { quoted?: number; due?: number }
}

interface Intents {
  created: { id: string; amountMinor: number }[]
  cancelled: { id: string; orderStatus: string }[]
}

interface OrderRow {
  subtotal_minor: number
  discount_total_minor: number
  total_minor: number
  status: string
  payment_intent_id: string | null
}

/** Every intent a kernel's checkout asks of its payments adapter, and the order's status at the moment of each cancel. */
function watchIntents(kernel: Kernel, reader: RawReader): Intents {
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
    const [row] = await reader.rows<{ status: string }>(
      'SELECT status FROM orders WHERE payment_intent_id = ?',
      [id],
    )
    intents.cancelled.push({ id, orderStatus: row?.status ?? 'no order' })
    return cancel(id)
  }
  return intents
}

let k: Kernel
let served: ServedKernel
let raw: RawReader
let intents: Intents

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  intents = watchIntents(k, raw)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

const pendingEmail = () => `buyer-${randomUUID()}+stub-pending@promo.test`

async function checkout(
  shop: Shop,
  email: string,
  over: { expectedTotalMinor?: unknown; shippingAddress?: Address } = {},
) {
  return shop.call<CheckoutAnswer>('POST', '/api/checkout', {
    email,
    billingAddress: address,
    shippingAddress: over.shippingAddress ?? address,
    ...('expectedTotalMinor' in over && { expectedTotalMinor: over.expectedTotalMinor }),
  })
}

function orderRow(reader: RawReader, orderId: string): Promise<OrderRow> {
  return reader.one<OrderRow>(
    'SELECT subtotal_minor, discount_total_minor, total_minor, status, payment_intent_id FROM orders WHERE id = ?',
    [orderId],
  )
}

function orderOf(kernel: Kernel, orderId: string) {
  return kernel.store.read(async (tx) => (await kernel.repos.order.findById(tx, orderId))!)
}

const redemptionsOf = (reader: RawReader, promotionId: string) =>
  reader.count('promotion_redemptions', 'promotion_id = ?', [promotionId])

const ordersBy = (reader: RawReader, email: string) => reader.count('orders', 'email = ?', [email])

const reservationsOf = (reader: RawReader, variantId: string) =>
  reader.count('inventory_reservations', 'variant_id = ?', [variantId])

const percent = (bps: number, over: Partial<PromotionSeed> = {}): PromotionSeed => ({
  code: uniqueCode('CHK'),
  kind: 'percent',
  percentBps: bps,
  ...over,
})

interface CodedCart {
  shop: Shop
  seeded: Seeded
  promotion: SeededPromotion
  cart: PricedCart
}

async function codedCart(
  seed: PromotionSeed,
  line: { priceMinor?: number; qty?: number; stock?: number } = {},
): Promise<CodedCart> {
  const promotion = await seedPromotion(k, seed)
  const seeded = await seedVariant(k, line.stock ?? 50, { priceMinor: line.priceMinor ?? 2000 })
  const shop = await primedShopper(served.baseUrl)
  expect((await readCart(shop)).status).toBe(200)
  expect((await addLine(shop, seeded, line.qty ?? 2)).status).toBe(200)
  const added = await putCode(shop, promotion.code)
  expect(added.status, JSON.stringify(added.body)).toBe(200)
  return { shop, seeded, promotion, cart: added.body.data! }
}

const orderEffect = (amountMinor: number, code: string): PromotionEffect => ({
  kind: 'order',
  amountMinor,
  label: code,
  code,
})

describe('AC-16: an order is written from the settled totals', () => {
  const arbLines = fc.array(
    fc.record({
      priceMinor: fc.integer({ min: 1, max: 40_000 }),
      qty: fc.integer({ min: 1, max: 4 }),
    }),
    { minLength: 1, maxLength: 3 },
  )

  it('AC-16: for a generated cart with a code, the order’s columns and lines are settleTotals’ and the charge is the total, and finalize of that amount confirms the order', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbLines,
        fc.oneof(
          fc.record({
            kind: fc.constant('percent' as const),
            bps: fc.integer({ min: 1, max: 9999 }),
          }),
          fc.record({
            kind: fc.constant('fixed' as const),
            fraction: fc.double({ min: 0, max: 0.99, noNaN: true }),
          }),
        ),
        async (lines, rule) => {
          const subtotal = lines.reduce((sum, l) => sum + l.priceMinor * l.qty, 0)
          const code = uniqueCode('ORDER')
          const seed: PromotionSeed =
            rule.kind === 'percent'
              ? { code, kind: 'percent', percentBps: rule.bps }
              : {
                  code,
                  kind: 'fixed',
                  amountOffMinor: Math.max(1, Math.floor(subtotal * rule.fraction)),
                  currency: 'GBP',
                }
          fc.pre(
            rule.kind === 'percent'
              ? Math.floor((subtotal * rule.bps) / 10_000) < subtotal
              : seed.amountOffMinor! < subtotal,
          )
          await seedPromotion(k, seed)
          const seeded = await Promise.all(
            lines.map((l) => seedVariant(k, l.qty + 5, { priceMinor: l.priceMinor })),
          )
          const shop = await primedShopper(served.baseUrl)
          expect((await readCart(shop)).status).toBe(200)
          for (const [i, s] of seeded.entries()) await addLine(shop, s, lines[i]!.qty)
          const cart = (await putCode(shop, code)).body.data!
          const amountOff =
            rule.kind === 'percent'
              ? Number((BigInt(subtotal) * BigInt(rule.bps)) / 10_000n)
              : Math.min(seed.amountOffMinor!, subtotal)

          const res = await checkout(shop, pendingEmail())

          expect(res.status, JSON.stringify(res.body)).toBe(200)
          const { orderId, paymentIntent } = res.body.data!
          const totals = settleTotals({
            currency: 'GBP',
            lines: cart.items.map((i) => ({
              id: i.variantId,
              unitMinor: i.priceMinor,
              qty: i.qty,
            })),
            shipping: null,
            effects: [orderEffect(amountOff, code)],
            tax: null,
            pricesIncludeTax: false,
          })
          const row = await orderRow(raw, orderId)
          expect(row.subtotal_minor).toBe(totals.subtotalMinor)
          expect(row.discount_total_minor).toBe(totals.discountTotalMinor)
          expect(row.total_minor).toBe(totals.totalMinor)

          const order = await orderOf(k, orderId)
          const items = order.lineItems as (OrderLineItem & { lineDiscountMinor?: number })[]
          for (const line of items) {
            expect(line.lineTotalMinor).toBe(line.unitPriceMinor * line.qty)
            const settled = totals.lines.find((l: CheckoutTotalsLine) => l.id === line.variantId)!
            expect(line.lineDiscountMinor ?? 0).toBe(settled.discountMinor)
            const variant = await k.store.read((tx) => k.repos.variant.findById(tx, line.variantId))
            expect(line.sku).toBe(variant!.sku)
          }
          expect(items.reduce((sum, l) => sum + l.lineTotalMinor, 0)).toBe(row.subtotal_minor)
          expect(items.reduce((sum, l) => sum + (l.lineDiscountMinor ?? 0), 0)).toBe(
            row.discount_total_minor,
          )
          expect(order.metadata).toMatchObject({
            promotions: { provider: 'native', codes: [code] },
          })
          const charged = intents.created.find((i) => i.id === paymentIntent.id)!
          expect(charged.amountMinor).toBe(row.total_minor)

          const done = await k.services.checkout.finalize(paymentIntent.id, {
            amountMinor: row.total_minor,
            currency: 'GBP',
          })
          expect(done.finalized, JSON.stringify(done)).toBe(true)
          expect((await orderRow(raw, orderId)).status).toBe('confirmed')
        },
      ),
      { numRuns: 20 },
    )
  })
})

describe('AC-17: a payment is for the quote it was placed at', () => {
  async function placed(seed: PromotionSeed = percent(1000)) {
    const coded = await codedCart(seed)
    const email = pendingEmail()
    const first = await checkout(coded.shop, email)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    return { ...coded, email, first: first.body.data! }
  }

  /** The old intent went first, while its order was still pending; the order is cancelled, and a new one stands. */
  async function expectSuperseded(
    first: CheckoutAnswer,
    again: { status: number; body: { data?: CheckoutAnswer } },
    newTotal: number,
  ): Promise<void> {
    expect(again.body.data!.orderId).not.toBe(first.orderId)
    expect(intents.cancelled.filter((c) => c.id === first.paymentIntent.id)).toEqual([
      { id: first.paymentIntent.id, orderStatus: 'pending' },
    ])
    expect((await orderRow(raw, first.orderId)).status).toBe('cancelled')
    const row = await orderRow(raw, again.body.data!.orderId)
    expect(row.status).toBe('pending')
    expect(row.total_minor).toBe(newTotal)
    expect(again.body.data!.paymentIntent.id).not.toBe(first.paymentIntent.id)
  }

  it('AC-17: an unchanged resubmit answers the same order and intent', async () => {
    const { shop, first, email } = await placed()
    const createdBefore = intents.created.length

    const again = await checkout(shop, email)

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data!.orderId).toBe(first.orderId)
    expect(again.body.data!.paymentIntent.id).toBe(first.paymentIntent.id)
    expect(intents.created.length).toBe(createdBefore)
  })

  it('AC-17: an absent optional address field equals an empty one, and key order does not matter: the pending order is reused', async () => {
    const { shop, first, email } = await placed()
    const sameAddress = {
      ...Object.fromEntries(Object.entries(address).reverse()),
      addressLine2: '',
    } as Address

    const again = await checkout(shop, email, { shippingAddress: sameAddress })

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data!.orderId).toBe(first.orderId)
    expect(again.body.data!.paymentIntent.id).toBe(first.paymentIntent.id)
  })

  it('AC-17: a changed shipping address cancels the old intent, then the order, and places a new order', async () => {
    const { shop, first, email, cart } = await placed()

    const again = await checkout(shop, email, {
      shippingAddress: { ...address, postalCode: 'N1 9GU' },
    })

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    await expectSuperseded(first, again, cart.totals.totalMinor)
  })

  it('AC-17: removing the code cancels the old intent, then the order, and places a new order at full price', async () => {
    const { shop, first, email, promotion, cart } = await placed()
    const removed = await shop.call('DELETE', `/api/cart/codes/${promotion.code}`)
    expect(removed.status, JSON.stringify(removed.body)).toBe(200)

    const again = await checkout(shop, email)

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    await expectSuperseded(first, again, cart.totals.subtotalMinor)
  })

  it('AC-17: adding a code after a first attempt cancels the old intent, then the order, and places a new order at the discounted total', async () => {
    const { shop, seeded, first, email } = await (async () => {
      const seededVariant = await seedVariant(k, 50, { priceMinor: 2000 })
      const s = await primedShopper(served.baseUrl)
      expect((await readCart(s)).status).toBe(200)
      expect((await addLine(s, seededVariant, 2)).status).toBe(200)
      const e = pendingEmail()
      const f = await checkout(s, e)
      expect(f.status, JSON.stringify(f.body)).toBe(200)
      return { shop: s, seeded: seededVariant, first: f.body.data!, email: e }
    })()
    const promotion = await seedPromotion(k, percent(2000))
    const added = (await putCode(shop, promotion.code)).body.data!
    expect(added.totals.discountTotalMinor).toBeGreaterThan(0)
    expect(first.totalMinor).toBe(seeded.priceMinor * 2)

    const again = await checkout(shop, email)

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    await expectSuperseded(first, again, added.totals.totalMinor)
  })

  it('AC-17: a discount changed after the first attempt cancels the old intent, then the order, and places a new order at the new total', async () => {
    const { shop, first, email, promotion, cart } = await placed(percent(1000))
    await updatePromotion(k, promotion.id, 'percent_bps', 2000)
    const subtotal = cart.totals.subtotalMinor

    const again = await checkout(shop, email)

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    await expectSuperseded(first, again, subtotal - Math.floor((subtotal * 2000) / 10_000))
  })
})

describe('AC-18: no charge the caller was not shown', () => {
  it('AC-18: an expectedTotalMinor that differs answers 409 checkout.total_changed with quoted and due, and creates nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5000 }), async (off) => {
        const { shop, seeded, promotion, cart } = await codedCart(percent(1000))
        const email = pendingEmail()
        const due = cart.totals.totalMinor
        const quoted = due + off
        const stockBefore = await stockOf(raw, seeded.variantId)
        const createdBefore = intents.created.length

        const res = await checkout(shop, email, { expectedTotalMinor: quoted })

        expect(res.status, JSON.stringify(res.body)).toBe(409)
        const error = res.body.error as unknown as ErrorBody
        expect(error.code).toBe('checkout.total_changed')
        expect(error.context).toEqual({ quoted, due })
        expect(await ordersBy(raw, email)).toBe(0)
        expect(await reservationsOf(raw, seeded.variantId)).toBe(0)
        expect(await redemptionsOf(raw, promotion.id)).toBe(0)
        expect(await stockOf(raw, seeded.variantId)).toBe(stockBefore)
        expect(intents.created.length).toBe(createdBefore)
      }),
      { numRuns: 5 },
    )
  })

  it('AC-18: a differing expected total leaves an existing pending order and its intent as they were', async () => {
    const { shop, cart } = await codedCart(percent(1000))
    const email = pendingEmail()
    const first = (await checkout(shop, email)).body.data!
    const cancelledBefore = intents.cancelled.length

    const res = await checkout(shop, email, { expectedTotalMinor: cart.totals.totalMinor + 1 })

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect((res.body.error as unknown as ErrorBody).code).toBe('checkout.total_changed')
    const row = await orderRow(raw, first.orderId)
    expect(row.status).toBe('pending')
    expect(row.payment_intent_id).toBe(first.paymentIntent.id)
    expect(intents.cancelled.length).toBe(cancelledBefore)
  })

  it('AC-18: an equal expectedTotalMinor and an absent one both proceed at the authoritative total', async () => {
    const withExpected = await codedCart(percent(1000))
    const absent = await codedCart(percent(1000))

    const equal = await checkout(withExpected.shop, pendingEmail(), {
      expectedTotalMinor: withExpected.cart.totals.totalMinor,
    })
    const none = await checkout(absent.shop, pendingEmail())

    expect(equal.status, JSON.stringify(equal.body)).toBe(200)
    expect(equal.body.data!.totalMinor).toBe(withExpected.cart.totals.totalMinor)
    expect(none.status, JSON.stringify(none.body)).toBe(200)
    expect(none.body.data!.totalMinor).toBe(absent.cart.totals.totalMinor)
  })

  it('AC-18: a non-integer or negative expectedTotalMinor answers 400 and places nothing', async () => {
    for (const bad of [10.5, -1, '100']) {
      const { shop } = await codedCart(percent(1000))
      const email = pendingEmail()

      const res = await checkout(shop, email, { expectedTotalMinor: bad })

      expect(res.status, `${String(bad)}: ${JSON.stringify(res.body)}`).toBe(400)
      expect(await ordersBy(raw, email)).toBe(0)
    }
  })
})

describe('AC-19: a discount is on an order only if the engine accepted it at place', () => {
  async function expiredSinceTheCart() {
    const coded = await codedCart(percent(1000))
    await updatePromotion(
      k,
      coded.promotion.id,
      'expires_at',
      new Date(Date.now() - 60_000).toISOString(),
    )
    return coded
  }

  it('AC-19: a code accepted on the cart and expired since, with a matching expected total, refuses total_changed with the full price due', async () => {
    const { shop, cart, seeded, promotion } = await expiredSinceTheCart()
    const email = pendingEmail()
    const createdBefore = intents.created.length

    const res = await checkout(shop, email, { expectedTotalMinor: cart.totals.totalMinor })

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    const error = res.body.error as unknown as ErrorBody
    expect(error.code).toBe('checkout.total_changed')
    expect(error.context).toEqual({
      quoted: cart.totals.totalMinor,
      due: cart.totals.subtotalMinor,
    })
    expect(await ordersBy(raw, email)).toBe(0)
    expect(await redemptionsOf(raw, promotion.id)).toBe(0)
    expect(await reservationsOf(raw, seeded.variantId)).toBe(0)
    expect(intents.created.length).toBe(createdBefore)
  })

  it('AC-19: with no expected total the order is at full price, with no promotion code and no redemption', async () => {
    const { shop, promotion, cart } = await expiredSinceTheCart()

    const res = await checkout(shop, pendingEmail())

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const orderId = res.body.data!.orderId
    const row = await orderRow(raw, orderId)
    expect(row.discount_total_minor).toBe(0)
    expect(row.total_minor).toBe(cart.totals.subtotalMinor)
    const order = await orderOf(k, orderId)
    expect((order.metadata as { promotions?: unknown }).promotions).toBeUndefined()
    expect(await redemptionsOf(raw, promotion.id)).toBe(0)
  })
})

describe('AC-21: at most k live uses of a cap-k code', () => {
  it('AC-21: a cancelled order’s use is available at once, with no consumer run', async () => {
    const seed = percent(1000, { usageCap: 1 })
    const holder = await codedCart(seed)
    const held = await checkout(holder.shop, pendingEmail())
    expect(held.status, JSON.stringify(held.body)).toBe(200)
    expect((await orderRow(raw, held.body.data!.orderId)).discount_total_minor).toBeGreaterThan(0)

    const seededOther = await seedVariant(k, 50, { priceMinor: 2000 })
    const blocked = await primedShopper(served.baseUrl)
    expect((await readCart(blocked)).status).toBe(200)
    await addLine(blocked, seededOther, 1)
    const refused = (await putCode(blocked, holder.promotion.code)).body.data!
    expect(refused.promotions.codes[0]).toMatchObject({ status: 'rejected', reason: 'cap_reached' })

    await k.services.checkout.cancel(held.body.data!.orderId, 'shopper cancelled')

    const freed = await checkout(blocked, pendingEmail())
    expect(freed.status, JSON.stringify(freed.body)).toBe(200)
    const row = await orderRow(raw, freed.body.data!.orderId)
    expect(row.discount_total_minor).toBe(200)
    expect(row.total_minor).toBe(row.subtotal_minor - 200)
  })

  it('AC-21: a shopper re-placing their own order on a cap-1 code keeps the discount when the pending order is reused', async () => {
    const { shop, promotion, cart } = await codedCart(percent(1000, { usageCap: 1 }))
    const email = pendingEmail()
    const first = (await checkout(shop, email)).body.data!

    const again = await checkout(shop, email)

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data!.orderId).toBe(first.orderId)
    const row = await orderRow(raw, first.orderId)
    expect(row.discount_total_minor).toBe(cart.totals.discountTotalMinor)
    expect(await redemptionsOf(raw, promotion.id)).toBe(1)
  })

  it('AC-21: a changed cart on a cap-1 code cancels the old order first and the new order keeps the discount', async () => {
    const { shop, seeded, promotion } = await codedCart(percent(1000, { usageCap: 1 }), {
      priceMinor: 2000,
      qty: 2,
    })
    const email = pendingEmail()
    const first = (await checkout(shop, email)).body.data!
    await shop.call('PATCH', `/api/cart/items/${seeded.variantId}`, { qty: 3 })

    const again = await checkout(shop, email)

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data!.orderId).not.toBe(first.orderId)
    const row = await orderRow(raw, again.body.data!.orderId)
    expect(row.discount_total_minor).toBe(Math.floor((2000 * 3 * 1000) / 10_000))
    expect(row.total_minor).toBe(row.subtotal_minor - row.discount_total_minor)
    expect((await orderRow(raw, first.orderId)).status).toBe('cancelled')
    expect(await redemptionsOf(raw, promotion.id)).toBe(2)
  })

  it('AC-21: a refund does not give a use back', async () => {
    const { shop, promotion } = await codedCart(percent(1000, { usageCap: 1 }))
    const paid = await checkout(shop, `paid-${randomUUID()}@promo.test`)
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    const { orderId, totalMinor } = paid.body.data!
    const admin = await adminClient(k, served.baseUrl)
    const refunded = await admin.call('POST', `/api/admin/orders/${orderId}/refund`, {
      amountMinor: totalMinor,
    })
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200)

    const seeded = await seedVariant(k, 20, { priceMinor: 1000 })
    const next = await primedShopper(served.baseUrl)
    expect((await readCart(next)).status).toBe(200)
    await addLine(next, seeded, 1)
    const cart = (await putCode(next, promotion.code)).body.data!

    expect(cart.promotions.codes[0]).toMatchObject({ status: 'rejected', reason: 'cap_reached' })
    expect(cart.totals.discountTotalMinor).toBe(0)
  })
})

interface ScriptedKernel {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  engine: ScriptedEngine
  intents: Intents
}

const scriptedKernels = new Map<string, Promise<ScriptedKernel>>()

/** A kernel with an injected engine, one per option set, built on first use so each test fails on its own. */
function scriptedKernel(opts: {
  automatic?: boolean
  onUnavailable?: 'proceed' | 'refuse'
}): Promise<ScriptedKernel> {
  const key = `${opts.automatic === true}:${opts.onUnavailable ?? 'proceed'}`
  let built = scriptedKernels.get(key)
  if (built === undefined) {
    built = (async () => {
      const engine = scriptedEngine({
        capabilities: opts.automatic === true ? ['codes', 'automatic'] : ['codes'],
      })
      const kernel = await createKernel({
        dialect: 'sqlite',
        configure: (config: NymbalConfig) =>
          ({
            ...config,
            commerce: {
              ...config.commerce,
              promotions: { provider: 'custom', onUnavailable: opts.onUnavailable ?? 'proceed' },
            },
          }) as NymbalConfig,
        appOptions: { adapters: { promotions: engine.adapter } },
      })
      const server = await serveKernel(kernel)
      const reader = openRaw(kernel.dialect, kernel.target)
      return {
        k: kernel,
        served: server,
        raw: reader,
        engine,
        intents: watchIntents(kernel, reader),
      }
    })()
    scriptedKernels.set(key, built)
  }
  return built
}

afterAll(async () => {
  for (const built of scriptedKernels.values()) {
    const s = await built.catch(() => undefined)
    await s?.raw.close()
    await s?.served.stop()
  }
})

async function scriptedCart(
  s: ScriptedKernel,
  opts: { code?: string; priceMinor?: number } = {},
): Promise<{ shop: Shop; seeded: Seeded }> {
  s.engine.recover()
  s.engine.answer(acceptFirstCode)
  const seeded = await seedVariant(s.k, 20, { priceMinor: opts.priceMinor ?? 2000 })
  const shop = await primedShopper(s.served.baseUrl)
  expect((await readCart(shop)).status).toBe(200)
  expect((await addLine(shop, seeded, 2)).status).toBe(200)
  if (opts.code !== undefined) {
    const added = await putCode(shop, opts.code)
    expect(added.status, JSON.stringify(added.body)).toBe(200)
  }
  return { shop, seeded }
}

describe('AC-22: never a guessed discount at place', () => {
  it('AC-22: with the engine down and a code on the cart, checkout answers 503 checkout.promotions_unavailable and writes nothing', async () => {
    const s = await scriptedKernel({})
    const { shop, seeded } = await scriptedCart(s, { code: 'DOWN' })
    const email = pendingEmail()
    const stockBefore = await stockOf(s.raw, seeded.variantId)
    const createdBefore = s.intents.created.length
    s.engine.fail()
    try {
      const res = await checkout(shop, email)

      expect(res.status, JSON.stringify(res.body)).toBe(503)
      expect(res.body.error?.code).toBe('checkout.promotions_unavailable')
      expect(await ordersBy(s.raw, email)).toBe(0)
      expect(await stockOf(s.raw, seeded.variantId)).toBe(stockBefore)
      expect(s.intents.created.length).toBe(createdBefore)
    } finally {
      s.engine.recover()
    }
  })

  it('AC-22: with the engine down and a code on the cart, an existing pending order and its intent are unchanged', async () => {
    const s = await scriptedKernel({})
    const { shop } = await scriptedCart(s, { code: 'HOLD' })
    const email = pendingEmail()
    const first = (await checkout(shop, email)).body.data!
    const cancelledBefore = s.intents.cancelled.length
    s.engine.fail()
    try {
      const res = await checkout(shop, email)

      expect(res.status, JSON.stringify(res.body)).toBe(503)
      const row = await orderRow(s.raw, first.orderId)
      expect(row.status).toBe('pending')
      expect(row.payment_intent_id).toBe(first.paymentIntent.id)
      expect(s.intents.cancelled.length).toBe(cancelledBefore)
    } finally {
      s.engine.recover()
    }
  })

  it('AC-22: with no code, an automatic engine down and onUnavailable proceed, the order is at full price with a history note beginning promotions.skipped', async () => {
    const s = await scriptedKernel({ automatic: true, onUnavailable: 'proceed' })
    const { shop, seeded } = await scriptedCart(s)
    s.engine.fail()
    try {
      const res = await checkout(shop, pendingEmail())

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const row = await orderRow(s.raw, res.body.data!.orderId)
      expect(row.total_minor).toBe(seeded.priceMinor * 2)
      expect(row.discount_total_minor).toBe(0)
      const notes = await historyNotes(s.raw, res.body.data!.orderId)
      expect(
        notes.some((note) => note.startsWith('promotions.skipped')),
        notes.join(' | '),
      ).toBe(true)
    } finally {
      s.engine.recover()
    }
  })

  it('AC-22: with no code, an automatic engine down and onUnavailable refuse, checkout answers 503 and writes nothing', async () => {
    const s = await scriptedKernel({ automatic: true, onUnavailable: 'refuse' })
    const { shop } = await scriptedCart(s)
    const email = pendingEmail()
    s.engine.fail()
    try {
      const res = await checkout(shop, email)

      expect(res.status, JSON.stringify(res.body)).toBe(503)
      expect(res.body.error?.code).toBe('checkout.promotions_unavailable')
      expect(await ordersBy(s.raw, email)).toBe(0)
    } finally {
      s.engine.recover()
    }
  })
})

describe('AC-23: a slow engine', () => {
  const BOUND_MS = 30
  /** Well under the shipped 3 s bound: passing proves the injected bound is the one applied. */
  const WELL_BEFORE_DEFAULT_BOUND_MS = 1500

  function services(engine: ScriptedEngine) {
    const cart = createCartService({
      store: k.store,
      carts: k.repos.cart,
      publisher: k.publisher,
      logger: k.logger,
      currency: 'GBP',
      promotions: engine.adapter,
      promotionsBoundMs: BOUND_MS,
    })
    const place = createCheckoutService({
      store: k.store,
      repos: k.repos,
      publisher: k.publisher,
      logger: k.logger,
      cart,
      orders: k.services.order,
      inventory: k.services.inventory,
      payments: k.app.adapters.payments,
      currency: 'GBP',
      promotions: engine.adapter,
      promotionsBoundMs: BOUND_MS,
    })
    return { cart, place }
  }

  /** A cart over the services, its stored promotions set directly: only the engine under test is ever consulted. */
  async function serviceCart(
    cart: ReturnType<typeof services>['cart'],
    seeded: Seeded,
    code: string,
    provider: string,
  ): Promise<string> {
    const { token } = await k.services.cart.getOrCreate()
    await k.services.cart.addItem(token, {
      variantId: seeded.variantId,
      productId: seeded.productId,
      productName: 'Widget',
      variantName: 'Default',
      priceMinor: seeded.priceMinor,
      imageUrl: '',
      qty: 1,
    })
    await writeRaw(k.dialect, k.target, 'UPDATE carts SET promotions = ? WHERE token = ?', [
      JSON.stringify({
        codes: [code],
        effects: [],
        provider,
        evaluatedAt: new Date().toISOString(),
        unavailable: false,
      }),
      token,
    ])
    expect((await cart.get(token))?.promotions?.codes).toEqual([code])
    return token
  }

  it('AC-23: an engine not marked inTransaction is abandoned at the bound as a failure: the cart row is released and a later command proceeds', async () => {
    const engine = scriptedEngine()
    engine.answer(() => new Promise(() => undefined))
    const { cart } = services(engine)
    const seeded = await seedVariant(k, 10, { priceMinor: 1500 })
    const token = await serviceCart(cart, seeded, 'SLOW', engine.adapter.providerName)

    const started = Date.now()
    await cart.updateItemQuantity(token, seeded.variantId, 2)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(WELL_BEFORE_DEFAULT_BOUND_MS)
    const after = await k.store.read((tx) => k.repos.cart.findByToken(tx, token))
    expect(after?.promotions?.unavailable).toBe(true)
    const later = await cart.updateItemQuantity(token, seeded.variantId, 3)
    expect(later.items[0]!.qty).toBe(3)
  })

  it('AC-23: an engine marked inTransaction is awaited past the bound and none of its statements run after the transaction ends', async () => {
    const engine = scriptedEngine({ inTransaction: true })
    let checkoutReturned = false
    let statementRanAfterReturn = false
    let evaluations = 0
    engine.answer(async (session) => {
      evaluations += 1
      await new Promise((resolve) => setTimeout(resolve, BOUND_MS * 4))
      await k.store.read((tx) => k.repos.cart.findByToken(tx, session.id))
      if (checkoutReturned) statementRanAfterReturn = true
      return acceptFirstCode(session, undefined)
    })
    const { cart, place } = services(engine)
    const seeded = await seedVariant(k, 10, { priceMinor: 1500 })
    const token = await serviceCart(cart, seeded, 'SLOWTX', engine.adapter.providerName)

    const started = await place.beginCheckout({
      cartToken: token,
      email: pendingEmail(),
      billingAddress: address,
      shippingAddress: address,
    })
    checkoutReturned = true
    // Long enough for an abandoned evaluation to have run on past the checkout.
    await new Promise((resolve) => setTimeout(resolve, BOUND_MS * 6))

    expect(evaluations).toBeGreaterThanOrEqual(1)
    expect(statementRanAfterReturn).toBe(false)
    expect((await orderOf(k, started.orderId)).discountTotalMinor).toBe(150)
  })
})

describe('AC-24: any engine’s effects settle the same way', () => {
  it('AC-24: an engine returning every effect kind and an unknown line id places an order whose totals follow settleTotals, and notice and unsupported move no money', async () => {
    const s = await scriptedKernel({})
    const seeded = await seedVariant(s.k, 20, { priceMinor: 3000 })
    const shop = await primedShopper(s.served.baseUrl)
    expect((await readCart(shop)).status).toBe(200)
    expect((await addLine(shop, seeded, 2)).status).toBe(200)
    const effects: PromotionEffect[] = [
      { kind: 'code_accepted', code: 'MIX' },
      { kind: 'line', lineId: seeded.variantId, amountMinor: 700, label: 'line', code: 'MIX' },
      { kind: 'line', lineId: 'no-such-line', amountMinor: 900, label: 'ghost', code: 'MIX' },
      { kind: 'order', amountMinor: 300, label: 'order', code: 'MIX' },
      { kind: 'shipping', amountMinor: 50, label: 'ship', code: 'MIX' },
      { kind: 'notice', text: 'Spend more' },
      { kind: 'unsupported', detail: 'free item' },
    ]
    s.engine.recover()
    s.engine.answer(() => ({ effects }))
    expect((await putCode(shop, 'MIX')).status).toBe(200)
    const lines = [{ id: seeded.variantId, unitMinor: 3000, qty: 2 }]
    const settle = (e: readonly PromotionEffect[]) =>
      settleTotals({
        currency: 'GBP',
        lines,
        shipping: null,
        effects: e,
        tax: null,
        pricesIncludeTax: false,
      })
    const expected = settle(effects)

    const res = await checkout(shop, pendingEmail())

    s.engine.answer(acceptFirstCode)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const row = await orderRow(s.raw, res.body.data!.orderId)
    expect(row.subtotal_minor).toBe(expected.subtotalMinor)
    expect(row.discount_total_minor).toBe(expected.discountTotalMinor)
    expect(row.total_minor).toBe(expected.totalMinor)
    expect(expected.discountTotalMinor).toBe(1000)
    const withoutNotes = settle(
      effects.filter((e) => e.kind !== 'notice' && e.kind !== 'unsupported'),
    )
    expect(withoutNotes.totalMinor).toBe(expected.totalMinor)
    const order = await s.k.store.read(async (tx) =>
      s.k.repos.order.findById(tx, res.body.data!.orderId),
    )
    const stored = (order!.metadata as { promotions?: { effects: PromotionEffect[] } }).promotions
    expect(stored?.effects.every((e) => e.kind !== 'notice' && e.kind !== 'unsupported')).toBe(true)
  })
})

describe('AC-25: no intent for a total of 0 on a cart with money in it', () => {
  it('AC-25: a code that would take the cart to 0 is rejected free_order_unsupported and the cart answers full price', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 30_000 }),
        fc.integer({ min: 1, max: 5 }),
        fc.nat({ max: 5000 }),
        async (priceMinor, qty, over) => {
          const subtotal = priceMinor * qty
          const { cart, promotion } = await codedCart(
            {
              code: uniqueCode('FREE'),
              kind: 'fixed',
              amountOffMinor: subtotal + over,
              currency: 'GBP',
            },
            { priceMinor, qty },
          )

          expect(cart.promotions.codes).toEqual([
            { code: promotion.code, status: 'rejected', reason: 'free_order_unsupported' },
          ])
          expect(cart.totals.discountTotalMinor).toBe(0)
          expect(cart.totals.totalMinor).toBe(subtotal)
          expect(cart.totals.subtotalMinor).toBe(subtotal)
        },
      ),
      { numRuns: 8 },
    )
  })

  it('AC-25: at place the same rule applies: expected at full price proceeds, the order is at full price with no code and no redemption, and no intent for 0 is made', async () => {
    const { shop, promotion, cart } = await codedCart(
      { code: uniqueCode('FREE2'), kind: 'fixed', amountOffMinor: 99_999, currency: 'GBP' },
      { priceMinor: 1500, qty: 2 },
    )
    const createdBefore = intents.created.length

    const res = await checkout(shop, pendingEmail(), {
      expectedTotalMinor: cart.totals.subtotalMinor,
    })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { orderId, paymentIntent } = res.body.data!
    const row = await orderRow(raw, orderId)
    expect(row.discount_total_minor).toBe(0)
    expect(row.total_minor).toBe(cart.totals.subtotalMinor)
    const order = await orderOf(k, orderId)
    expect((order.metadata as { promotions?: unknown }).promotions).toBeUndefined()
    expect(await redemptionsOf(raw, promotion.id)).toBe(0)
    const made = intents.created.slice(createdBefore)
    expect(made.map((i) => i.id)).toEqual([paymentIntent.id])
    expect(made.every((i) => i.amountMinor === row.total_minor && i.amountMinor > 0)).toBe(true)
  })

  it('AC-25: a cart whose subtotal is already 0 is unaffected by the rule', async () => {
    const { cart, promotion } = await codedCart(
      { code: uniqueCode('ZERO'), kind: 'fixed', amountOffMinor: 500, currency: 'GBP' },
      { priceMinor: 0, qty: 1 },
    )

    expect(cart.totals.subtotalMinor).toBe(0)
    expect(cart.totals.totalMinor).toBe(0)
    expect(cart.promotions.codes.find((c) => c.code === promotion.code)?.reason).not.toBe(
      'free_order_unsupported',
    )
  })
})
