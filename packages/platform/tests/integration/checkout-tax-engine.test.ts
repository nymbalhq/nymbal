import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ConfigError,
  type Address,
  type PaymentIntentParams,
  type TaxQuote,
  type TaxQuoteLine,
} from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { adminClient } from '../support/money.js'
import { seedPromotion, uniqueCode, type PricedCart, type Shop } from '../support/promotions.js'
import { openRaw, stockOf, writeRaw, type RawReader } from '../support/raw.js'
import { bearer, bearerOf, registeredCustomer } from '../support/recently-viewed.js'
import { primedShopper } from '../support/security.js'
import {
  DESTINATIONS,
  RATES,
  scriptedTax,
  taxOnTop,
  UNTAXED,
  withTax,
  type Outage,
  type ScriptedTax,
  type TaxSetup,
} from '../support/tax.js'
import { historyNotes } from '../support/webhooks.js'

// A tax provider in the `custom` slot, scripted by the test, through a checkout over HTTP on served kernels (SQLite):
// what the kernel sends it, what the order keeps of its answer, and what an outage does under each setting. The
// native engine's own maths is checkout-tax.test.ts's.

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  totalMinor: number
  paymentIntent: { id: string; amountMinor: number }
  orderKey?: string
}

interface Store {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  tax: ScriptedTax
  intents: { created: number; cancelled: number }
}

const WAREHOUSE: Address = {
  firstName: 'Nymbal',
  lastName: 'Warehouse',
  addressLine1: '1 Dock Road',
  city: 'Leeds',
  region: 'West Yorkshire',
  postalCode: 'LS1 4AP',
  country: 'GB',
}

async function serve(tax: ScriptedTax, setup: TaxSetup): Promise<Store> {
  const k = await createKernel({
    dialect: 'sqlite',
    configure: withTax({ provider: 'custom', ...setup }),
    appOptions: { adapters: { tax: tax.adapter } },
  })
  const served = await serveKernel(k)
  const intents = { created: 0, cancelled: 0 }
  const payments = k.app.adapters.payments
  const create = payments.createPaymentIntent.bind(payments)
  const cancel = payments.cancelPaymentIntent.bind(payments)
  payments.createPaymentIntent = async (params: PaymentIntentParams) => {
    intents.created += 1
    return create(params)
  }
  payments.cancelPaymentIntent = async (id: string) => {
    intents.cancelled += 1
    return cancel(id)
  }
  return { k, served, raw: openRaw(k.dialect, k.target), tax, intents }
}

/** The provider adds tax on top; the store has no ship-from address. */
let onTop: Store
/** The provider extracts tax from prices that include it; the store ships from its warehouse. */
let within: Store
/** The provider answers no tax when up; the store refuses a checkout while it is down. */
let refusing: Store
/** The provider adds tax on top when up; the store falls back to its native table while it is down. */
let falling: Store

beforeAll(async () => {
  ;[onTop, within, refusing, falling] = await Promise.all([
    serve(scriptedTax(), {}),
    serve(scriptedTax(), { pricesIncludeTax: true, shipFrom: WAREHOUSE }),
    serve(scriptedTax({ percent: 0 }), { onUnavailable: 'refuse' }),
    serve(scriptedTax(), { onUnavailable: 'native', rates: RATES }),
  ])
}, 60_000)

afterAll(async () => {
  for (const s of [onTop, within, refusing, falling]) {
    s?.tax.recover()
    await s?.raw.close()
    await s?.served.stop()
  }
})

const pendingEmail = () => `buyer-${randomUUID()}+stub-pending@tax-engine.test`

interface Basket {
  shop: Shop
  seeded: Seeded[]
  cart: PricedCart
  /** The authorization header every call of a signed-in shopper carries; empty for a guest. */
  auth: Record<string, string>
  email: string
}

/**
 * A shopper of its own (a guest, or `signedIn` as a registered customer) with these lines and, given `bps`, a code
 * taking that much off the order. `before` runs on the seeded variants before anything is added to the cart.
 */
async function basket(
  s: Store,
  lines: ReadonlyArray<{ priceMinor: number; qty: number }>,
  opts: {
    bps?: number
    signedIn?: { metadata?: Record<string, unknown> }
    before?: (seeded: Seeded[]) => Promise<void>
  } = {},
): Promise<Basket> {
  const seeded = await Promise.all(
    lines.map((l) => seedVariant(s.k, l.qty + 5, { priceMinor: l.priceMinor })),
  )
  // A raw write waits on the store's lock with the thread asleep: the last command's pass must be done first.
  await s.k.app.relay.drain()
  await opts.before?.(seeded)
  const shop = await primedShopper(s.served.baseUrl)
  let auth: Record<string, string> = {}
  let email = pendingEmail()
  if (opts.signedIn !== undefined) {
    const customer = await registeredCustomer(s.k)
    if (opts.signedIn.metadata !== undefined) {
      await s.k.app.relay.drain()
      await writeRaw(s.k.dialect, s.k.target, 'UPDATE customers SET metadata = ? WHERE id = ?', [
        JSON.stringify(opts.signedIn.metadata),
        customer.id,
      ])
    }
    auth = bearer(await bearerOf(s.served.baseUrl, shop.jar, customer))
    email = customer.email
  }
  expect((await shop.call('GET', '/api/cart', undefined, { headers: auth })).status).toBe(200)
  for (const [i, v] of seeded.entries()) {
    const added = await shop.call(
      'POST',
      '/api/cart/items',
      { variantId: v.variantId, qty: lines[i]!.qty },
      { headers: auth },
    )
    expect(added.status, JSON.stringify(added.body)).toBe(200)
  }
  if (opts.bps !== undefined) {
    await s.k.app.relay.drain()
    const promotion = await seedPromotion(s.k, {
      code: uniqueCode('ENGINE'),
      kind: 'percent',
      percentBps: opts.bps,
    })
    const coded = await shop.call(
      'POST',
      '/api/cart/codes',
      { code: promotion.code },
      { headers: auth },
    )
    expect(coded.status, JSON.stringify(coded.body)).toBe(200)
  }
  const cart = (await shop.call<PricedCart>('GET', '/api/cart', undefined, { headers: auth })).body
    .data!
  return { shop, seeded, cart, auth, email }
}

function checkout(b: Basket, over: { expectedTotalMinor?: number; shipTo?: Address } = {}) {
  const shipTo = over.shipTo ?? address
  return b.shop.call<CheckoutAnswer>(
    'POST',
    '/api/checkout',
    {
      email: b.email,
      billingAddress: shipTo,
      shippingAddress: shipTo,
      ...(over.expectedTotalMinor !== undefined && { expectedTotalMinor: over.expectedTotalMinor }),
    },
    { headers: b.auth },
  )
}

/** Each cart line's amount tax is due on: its subtotal less its discount. */
const amounts = (cart: PricedCart): Map<string, number> =>
  new Map(cart.totals.lines.map((l) => [l.id, l.subtotalMinor - l.discountMinor]))

const sum = (values: Iterable<number>): number => [...values].reduce((total, v) => total + v, 0)

/** The total a caller is shown on a store adding `percent` on top of each discounted line. */
const taxedTotal = (cart: PricedCart, percent: number): number =>
  cart.totals.totalMinor + sum([...amounts(cart).values()].map((a) => taxOnTop(a, percent)))

const skuOf = async (s: Store, variantId: string): Promise<string> =>
  (await s.k.store.read((tx) => s.k.repos.variant.findById(tx, variantId)))!.sku

function orderOf(s: Store, orderId: string) {
  return s.k.store.read(async (tx) => (await s.k.repos.order.findById(tx, orderId))!)
}

/** Places `b`'s order as the store's flag needs it: with the taxed total on top, with none when prices include tax. */
async function place(s: Store, b: Basket, shipTo: Address = address) {
  const inclusive = s === within
  const res = await checkout(b, {
    shipTo,
    ...(!inclusive && { expectedTotalMinor: taxedTotal(b.cart, s.tax.percent) }),
  })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

describe('AC-13: what the kernel sends a tax provider', () => {
  // Kills: a provider handed the gross amount, an empty SKU, a ship-from it was not configured with, or another token.
  it('AC-13: each line’s id, sku, discounted amount and quantity; the shipping address; ship-from exactly when the store has one; the store’s flag; no shipping; the cart’s currency; and the cart token as the reference of every quote', async () => {
    for (const s of [onTop, within]) {
      const inclusive = s === within
      const b = await basket(
        s,
        [
          { priceMinor: 2_999, qty: 2 },
          { priceMinor: 1_250, qty: 3 },
        ],
        { bps: 1_500 },
      )
      const shipTo = DESTINATIONS[1]!.shipTo
      const from = s.tax.calls.length

      await place(s, b, shipTo)

      const calls = s.tax.calls.slice(from)
      expect(calls.length, 'quotes asked for one checkout').toBe(1)
      const due = amounts(b.cart)
      const expectedLines = await Promise.all(
        b.cart.items.map(async (item) => ({
          id: item.variantId,
          sku: await skuOf(s, item.variantId),
          amountMinor: due.get(item.variantId)!,
          qty: item.qty,
        })),
      )
      for (const call of calls) {
        expect(call.lines).toEqual(expectedLines)
        expect(call.shipTo).toEqual(shipTo)
        expect(call.shipFrom ?? 'absent').toEqual(inclusive ? WAREHOUSE : 'absent')
        expect(call.pricesIncludeTax).toBe(inclusive)
        expect(call.shipping).toBeNull()
        expect(call.currency).toBe(b.cart.currency)
        expect(call.reference).toBe(b.cart.token)
        expect(call.customer).toEqual({ id: null })
      }
      // The discount is what the provider was told the lines cost less.
      expect(sum(calls[0]!.lines.map((l: TaxQuoteLine) => l.amountMinor))).toBe(
        b.cart.totals.subtotalMinor - b.cart.totals.discountTotalMinor,
      )
    }
  })

  // Kills: a provider handed the wrong tax code, or the product's code over the variant's own.
  it('AC-13: a line’s taxCode is its variant’s, else its product’s, and absent when neither has one', async () => {
    const codes = [
      { variant: 'food', product: 'books', sent: 'food' },
      { variant: null, product: 'books', sent: 'books' },
      { variant: null, product: null, sent: undefined },
      { variant: 'clothing', product: null, sent: 'clothing' },
    ]
    const b = await basket(
      onTop,
      codes.map(() => ({ priceMinor: 1_000, qty: 1 })),
      {
        before: async (seeded) => {
          for (const [i, v] of seeded.entries()) {
            const { variant, product } = codes[i]!
            await writeRaw(
              onTop.k.dialect,
              onTop.k.target,
              'UPDATE variants SET tax_code = ? WHERE id = ?',
              [variant, v.variantId],
            )
            await writeRaw(
              onTop.k.dialect,
              onTop.k.target,
              'UPDATE products SET tax_code = ? WHERE id = ?',
              [product, v.productId],
            )
          }
        },
      },
    )
    const from = onTop.tax.calls.length

    await place(onTop, b)

    const call = onTop.tax.calls[from]!
    const byVariant = new Map<string, TaxQuoteLine>(call.lines.map((l: TaxQuoteLine) => [l.id, l]))
    b.seeded.forEach((v, i) => {
      const line = byVariant.get(v.variantId)!
      expect(Object.hasOwn(line, 'taxCode') ? line.taxCode : 'absent', `line ${i}`).toBe(
        codes[i]!.sent ?? 'absent',
      )
    })
  })

  // Kills: an exemption passed on from a malformed metadata value, or a signed-in customer sent as a guest.
  it('AC-13: customer.id is the signed-in customer, with exemption exactly when metadata.taxExemption is { kind: string, certificateId?: string }', async () => {
    const cases: Array<{ metadata: Record<string, unknown>; exemption?: unknown }> = [
      {
        metadata: { taxExemption: { kind: 'resale', certificateId: 'CERT-1' } },
        exemption: { kind: 'resale', certificateId: 'CERT-1' },
      },
      { metadata: { taxExemption: { kind: 'nonprofit' } }, exemption: { kind: 'nonprofit' } },
      { metadata: {} },
      { metadata: { taxExemption: 'resale' } },
      { metadata: { taxExemption: { kind: 5 } } },
      { metadata: { taxExemption: { certificateId: 'CERT-2' } } },
      { metadata: { taxExemption: { kind: 'resale', certificateId: 7 } } },
      { metadata: { taxExemption: null } },
    ]
    for (const c of cases) {
      const b = await basket(onTop, [{ priceMinor: 1_500, qty: 1 }], {
        signedIn: { metadata: c.metadata },
      })
      const customerId = (await onTop.k.store.read((tx) =>
        onTop.k.repos.customer.findByEmail(tx, b.email),
      ))!.id
      const from = onTop.tax.calls.length

      await place(onTop, b)

      const calls = onTop.tax.calls.slice(from)
      expect(calls.length, JSON.stringify(c.metadata)).toBe(1)
      for (const call of calls) {
        expect(call.customer, JSON.stringify(c.metadata)).toEqual(
          c.exemption === undefined
            ? { id: customerId }
            : { id: customerId, exemption: c.exemption },
        )
      }
    }
  })
})

interface ShopperOrderView {
  totalMinor: number
  taxTotalMinor: number
  pricesIncludeTax?: boolean
}

describe('AC-14: the order records its tax', () => {
  // Kills: an inclusive order no reader can tell from an exclusive one; a quote reshaped or lost on its way to the order.
  it('AC-14: each line’s tax is the quote’s and its total gross, metadata.tax is the provider’s whole answer with no fallback mark, and the keyed, owner and admin reads answer pricesIncludeTax', async () => {
    for (const s of [onTop, within]) {
      const inclusive = s === within
      const admin = await adminClient(s.k, s.served.baseUrl)
      for (const signedIn of [false, true]) {
        const b = await basket(
          s,
          [
            { priceMinor: 4_321, qty: 2 },
            { priceMinor: 999, qty: 1 },
          ],
          { bps: 1_000, ...(signedIn && { signedIn: {} }) },
        )
        const from = s.tax.answers.length

        const placed = await place(s, b)

        const answer: TaxQuote = s.tax.answers.at(-1)!
        expect(s.tax.answers.length).toBeGreaterThan(from)
        const order = await orderOf(s, placed.orderId)
        const quoted = new Map(
          answer.lines.map((l: TaxQuote['lines'][number]) => [l.id, l.taxMinor]),
        )
        for (const line of order.lineItems) {
          expect(line.lineTaxMinor, line.variantId).toBe(quoted.get(line.variantId))
          expect(line.lineTotalMinor, line.variantId).toBe(line.unitPriceMinor * line.qty)
        }
        expect(order.taxTotalMinor).toBe(answer.totalTaxMinor)
        expect((order.metadata as { tax?: unknown }).tax).toEqual(answer)
        expect('fallback' in ((order.metadata as { tax?: object }).tax ?? {})).toBe(false)
        expect(order.pricesIncludeTax).toBe(inclusive)

        const read = await admin.call<ShopperOrderView>(
          'GET',
          `/api/admin/orders/${placed.orderNumber}`,
        )
        expect(read.status, JSON.stringify(read.body)).toBe(200)
        expect(read.body.data!.pricesIncludeTax, 'admin read').toBe(inclusive)

        const headers = signedIn ? b.auth : { 'x-nymbal-order-key': placed.orderKey! }
        await vi.waitFor(
          async () => {
            const shown = await b.shop.call<ShopperOrderView>(
              'GET',
              `/api/orders/${placed.orderNumber}`,
              undefined,
              { headers },
            )
            expect(shown.status, JSON.stringify(shown.body)).toBe(200)
            expect(shown.body.data!.taxTotalMinor).toBe(answer.totalTaxMinor)
            expect(shown.body.data!.pricesIncludeTax, signedIn ? 'owner read' : 'keyed read').toBe(
              inclusive,
            )
          },
          { timeout: 5_000, interval: 25 },
        )
      }
    }
  })

  // Kills: a provider's answer of no tax dropped from the order as if no engine had been asked.
  it('AC-14: a provider’s zero-tax answer is kept whole on metadata.tax, with no tax on the lines or the column', async () => {
    const s = refusing
    const b = await basket(s, [{ priceMinor: 2_500, qty: 2 }])
    const from = s.tax.answers.length

    const placed = await place(s, b)

    expect(s.tax.answers.length).toBe(from + 1)
    const answer: TaxQuote = s.tax.answers.at(-1)!
    expect(answer.totalTaxMinor).toBe(0)
    const order = await orderOf(s, placed.orderId)
    expect((order.metadata as { tax?: unknown }).tax).toEqual(answer)
    expect(order.taxTotalMinor).toBe(0)
    expect(order.lineItems.map((l) => l.lineTaxMinor)).toEqual([0])
    expect(order.totalMinor).toBe(b.cart.totals.totalMinor)
  })
})

const OUTAGES: readonly Outage[] = ['throws', 'bound', 'invalid']

describe('AC-15: never a guessed tax', () => {
  // Kills: a down or broken engine yielding a zero or partial tax; a slow engine holding the cart lock.
  it.each(OUTAGES)(
    'AC-15: with onUnavailable refuse and a provider that %s, POST /api/checkout answers 503 checkout.tax_unavailable, writes nothing, leaves the pending order and its intent alone, and a later cart command proceeds',
    async (outage) => {
      const s = refusing
      const b = await basket(s, [{ priceMinor: 2_000, qty: 2 }])
      const first = await checkout(b)
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const placed = first.body.data!
      const variant = b.seeded[0]!.variantId
      const before = {
        orders: await s.raw.count('orders', 'email = ?', [b.email]),
        reservations: await s.raw.count('inventory_reservations', 'variant_id = ?', [variant]),
        stock: await stockOf(s.raw, variant),
        intents: { ...s.intents },
      }
      s.tax.fail(outage)
      try {
        const res = await checkout(b)

        expect(res.status, JSON.stringify(res.body)).toBe(503)
        expect(res.body.error?.code).toBe('checkout.tax_unavailable')
        expect({
          orders: await s.raw.count('orders', 'email = ?', [b.email]),
          reservations: await s.raw.count('inventory_reservations', 'variant_id = ?', [variant]),
          stock: await stockOf(s.raw, variant),
          intents: { ...s.intents },
        }).toEqual(before)
        const row = await s.raw.one<{ status: string; payment_intent_id: string }>(
          'SELECT status, payment_intent_id FROM orders WHERE id = ?',
          [placed.orderId],
        )
        expect(row).toEqual({ status: 'pending', payment_intent_id: placed.paymentIntent.id })

        const added = await b.shop.call('POST', '/api/cart/items', { variantId: variant, qty: 1 })
        expect(added.status, JSON.stringify(added.body)).toBe(200)
      } finally {
        s.tax.recover()
      }
    },
  )
})

describe('AC-16: the native table when the provider is down, by the merchant’s choice', () => {
  // Kills: the merchant's opt-in ignored, or a fallback order that cannot be told from one the provider quoted.
  it.each(OUTAGES)(
    'AC-16: with onUnavailable native and a provider that %s, the order is placed at the native table’s tax, metadata.tax is the native quote marked fallback, and a history note begins tax.fallback',
    async (outage) => {
      const s = falling
      const b = await basket(
        s,
        [
          { priceMinor: 1_999, qty: 2 },
          { priceMinor: 750, qty: 1 },
        ],
        { bps: 500 },
      )
      const native = new Map([...amounts(b.cart)].map(([id, a]) => [id, taxOnTop(a, 20)]))
      s.tax.fail(outage)
      try {
        const res = await checkout(b, {
          expectedTotalMinor: b.cart.totals.totalMinor + sum(native.values()),
        })

        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const order = await orderOf(s, res.body.data!.orderId)
        for (const line of order.lineItems) {
          expect(line.lineTaxMinor, line.variantId).toBe(native.get(line.variantId))
        }
        expect(order.taxTotalMinor).toBe(sum(native.values()))
        const tax = (order.metadata as { tax?: TaxQuote & { fallback?: boolean } }).tax
        expect(tax).toMatchObject({
          provider: 'native',
          fallback: true,
          totalTaxMinor: sum(native.values()),
        })
        const notes = await historyNotes(s.raw, order.id)
        expect(
          notes.some((n) => n.startsWith('tax.fallback')),
          notes.join(' | '),
        ).toBe(true)
      } finally {
        s.tax.recover()
      }
    },
  )
})

describe('AC-16: a fallback that owes nothing is still marked', () => {
  // Kills: a zero native fallback recorded as no answer at all, so an order the provider never quoted reads as untaxed.
  it('AC-16: with onUnavailable native, a provider that throws and a destination with no row, the order is placed with no tax, metadata.tax is the native zero quote marked fallback, and a history note begins tax.fallback', async () => {
    const s = falling
    const b = await basket(s, [{ priceMinor: 1_999, qty: 2 }])
    s.tax.fail('throws')
    try {
      const res = await checkout(b, {
        shipTo: UNTAXED,
        expectedTotalMinor: b.cart.totals.totalMinor,
      })

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const order = await orderOf(s, res.body.data!.orderId)
      expect(order.taxTotalMinor).toBe(0)
      expect(order.totalMinor).toBe(b.cart.totals.totalMinor)
      expect((order.metadata as { tax?: unknown }).tax).toMatchObject({
        provider: 'native',
        fallback: true,
        totalTaxMinor: 0,
        lines: [{ id: b.seeded[0]!.variantId, taxMinor: 0, ratePpm: 0 }],
      })
      const notes = await historyNotes(s.raw, order.id)
      expect(
        notes.some((n) => n.startsWith('tax.fallback')),
        notes.join(' | '),
      ).toBe(true)
    } finally {
      s.tax.recover()
    }
  })
})

describe('AC-17: an inclusive store needs an engine that extracts tax', () => {
  /** What createApp does with this setup: boots (and is closed again) or refuses with an error. */
  async function boot(setup: TaxSetup, adapter?: ScriptedTax['adapter']): Promise<unknown> {
    try {
      const k = await createKernel({
        dialect: 'sqlite',
        configure: withTax(setup),
        ...(adapter !== undefined && { appOptions: { adapters: { tax: adapter } } }),
      })
      await k.close()
      return 'booted'
    } catch (err) {
      return err
    }
  }

  // Kills: a provider that only adds tax handed inclusive prices, and taxing them twice.
  it('AC-17: createApp refuses pricesIncludeTax with a provider that does not declare inclusive, naming the flag and the provider; with one that does, or the native engine, it boots', async () => {
    const adding = scriptedTax({ capabilities: ['quote'] })
    const refused = await boot({ provider: 'custom', pricesIncludeTax: true }, adding.adapter)

    expect(refused).toBeInstanceOf(ConfigError)
    const message = (refused as Error).message
    expect(message).toMatch(/pricesIncludeTax/)
    expect(message).toMatch(/custom|scripted-tax/)

    expect(await boot({ provider: 'custom', pricesIncludeTax: false }, adding.adapter)).toBe(
      'booted',
    )
    expect(await boot({ provider: 'custom', pricesIncludeTax: true }, scriptedTax().adapter)).toBe(
      'booted',
    )
    expect(await boot({ provider: 'native', pricesIncludeTax: true, rates: RATES })).toBe('booted')
  })
})
