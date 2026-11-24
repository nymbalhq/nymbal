import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Order, TransactionalEmail } from '@nymbalhq/types'
import {
  contextOf,
  HEARTBEAT_ADDRESS,
  HEARTBEAT_EMAIL,
  quotedCheckout,
  watchProvider,
  withHeartbeat,
  type ProviderCall,
} from '../support/heartbeat.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { adminClient } from '../support/money.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { addLine } from '../support/promotions.js'
import { primedShopper } from '../support/security.js'
import { both, placeOrder, withShipping, type ShippingRow } from '../support/shipping.js'
import { withTax } from '../support/tax.js'

// The heartbeat's store check through the kernel over HTTP (SQLite): a checkout with the store's exact heartbeat
// address, while `features.heartbeat` is on, places an order marked synthetic and cancels it in the same transaction,
// answering checkout.synthetic; it never calls the payments provider, never moves stock and leaves nothing downstream.
// Any other address, and the address itself with the feature off, is an ordinary checkout. Every store here charges
// paid shipping with tax on top, so a checkout that sends no quoted total is refused.

/** Two paid GB options, so a quote has a choice and a checkout must name the one it was quoted. */
const RATES: ShippingRow[] = [
  { id: 'standard', name: 'Standard', countries: ['GB'], amountMinor: 450, estimatedDays: 3 },
  { id: 'express', name: 'Express', countries: ['GB'], amountMinor: 999, estimatedDays: 1 },
]
const TAXED = withTax({ rates: [{ country: 'GB', percent: 20, taxShipping: true }] })

interface Store {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  provider: ProviderCall[]
}

async function serve(heartbeatOn: boolean): Promise<Store> {
  const k = await createKernel({
    dialect: 'sqlite',
    configure: both(TAXED, withShipping(RATES), withHeartbeat(HEARTBEAT_EMAIL, heartbeatOn)),
  })
  const served = await serveKernel(k)
  return { k, served, raw: openRaw(k.dialect, k.target), provider: watchProvider(k) }
}

async function close(s: Store | undefined): Promise<void> {
  await s?.raw.close()
  await s?.served.stop()
}

const stockOf = async (s: Store, v: Seeded): Promise<number> =>
  (await s.raw.one<{ stock: number }>('SELECT stock FROM variants WHERE id = ?', [v.variantId]))
    .stock
const reservationsOf = (s: Store, v: Seeded): Promise<number> =>
  s.raw.count('inventory_reservations', 'variant_id = ?', [v.variantId])

const orderByNumber = (s: Store, orderNumber: string): Promise<Order | null> =>
  s.k.store.read((tx) => s.k.repos.order.findByOrderNumber(tx, orderNumber))

/** H with each letter's case chosen by `mask`, and whitespace either side. */
function spelled(mask: boolean[], lead: string, trail: string): string {
  const letters = [...HEARTBEAT_EMAIL].map((c, i) => (mask[i] ? c.toUpperCase() : c.toLowerCase()))
  return `${lead}${letters.join('')}${trail}`
}

const SPACE = fc.constantFrom('', ' ', '  ', '\t', ' \t ')
const spellingArb = fc
  .tuple(
    fc.array(fc.boolean(), {
      minLength: HEARTBEAT_EMAIL.length,
      maxLength: HEARTBEAT_EMAIL.length,
    }),
    SPACE,
    SPACE,
  )
  .map(([mask, lead, trail]) => spelled(mask, lead, trail))

describe('synthetic store check: the heartbeat address places and cancels, and never pays', () => {
  let s: Store
  let variant: Seeded

  beforeAll(async () => {
    s = await serve(true)
    variant = await seedVariant(s.k, 50, { priceMinor: 1_250 })
  }, 60_000)
  afterAll(() => close(s))

  // Kills: the switch creating an intent (on the stub, a capture and a confirmed order), leaving the order pending,
  // reserving or taking stock, answering 200, or skipping the total check for the heartbeat address.
  it('AC-1: property over case and surrounding whitespace of H: with the quoted total and option the checkout answers 409 checkout.synthetic naming the order and its key; the order is synthetic, cancelled, uncaptured, at the quoted total with one move to cancelled; stock never moves; the provider is never called; without the total it is refused total_changed and places nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        spellingArb,
        fc.constantFrom('standard', 'express'),
        async (email, optionId) => {
          const stockBefore = await stockOf(s, variant)
          const callsBefore = s.provider.length

          // The same request with no total: refused before anything is placed.
          const shop = await primedShopper(s.served.baseUrl)
          expect((await addLine(shop, variant, 1)).status).toBe(200)
          const ordersBefore = await s.raw.count('orders')
          const unquoted = await placeOrder(shop, email, { shippingAddress: HEARTBEAT_ADDRESS })
          expect(unquoted.status, JSON.stringify(unquoted.body)).toBe(409)
          expect(unquoted.body.error?.code).toBe('checkout.total_changed')
          expect(await s.raw.count('orders')).toBe(ordersBefore)

          const check = await quotedCheckout(s.served.baseUrl, variant, email, {
            optionId,
            afterQuote: async () => {
              expect(await stockOf(s, variant), 'stock after the quote').toBe(stockBefore)
            },
          })
          const quoted = check.quoted.body.data!

          expect(check.answer.status, JSON.stringify(check.answer.body)).toBe(409)
          expect(check.answer.body.error?.code).toBe('checkout.synthetic')
          const context = contextOf(check.answer)
          expect(typeof context['orderNumber'], JSON.stringify(context)).toBe('string')
          expect(typeof context['orderKey'], JSON.stringify(context)).toBe('string')

          const order = await orderByNumber(s, context['orderNumber'] as string)
          expect(order, `order ${String(context['orderNumber'])}`).not.toBeNull()
          expect({
            source: order!.source,
            status: order!.status,
            capturedMinor: order!.capturedMinor,
            paymentIntentId: order!.paymentIntentId,
          }).toEqual({
            source: 'synthetic',
            status: 'cancelled',
            capturedMinor: 0,
            paymentIntentId: null,
          })
          expect(order!.totalMinor, 'the order is at the quoted total').toBe(
            quoted.totals.totalMinor,
          )
          const history = await s.k.store.read((tx) =>
            s.k.repos.orderHistory.listByOrder(tx, order!.id),
          )
          expect(history.filter((h) => h.toStatus === 'cancelled')).toHaveLength(1)

          expect(await stockOf(s, variant), 'stock after the checkout').toBe(stockBefore)
          expect(await reservationsOf(s, variant)).toBe(0)
          expect(s.provider.slice(callsBefore).map((c) => c.method)).toEqual([])
        },
      ),
      {
        numRuns: 6,
        examples: [
          [HEARTBEAT_EMAIL, 'standard'],
          [HEARTBEAT_EMAIL.toUpperCase(), 'express'],
          [`  ${HEARTBEAT_EMAIL}  `, 'standard'],
        ],
      },
    )
  }, 120_000)
})

describe('synthetic store check: only the exact address, with the feature on, is diverted', () => {
  let on: Store
  let off: Store
  let onVariant: Seeded
  let offVariant: Seeded
  /** The metadata keys an ordinary checkout gives its intent on the store with the feature on. */
  let controlKeys: string[]

  beforeAll(async () => {
    ;[on, off] = await Promise.all([serve(true), serve(false)])
    ;[onVariant, offVariant] = await Promise.all([
      seedVariant(on.k, 500, { priceMinor: 1_250 }),
      seedVariant(off.k, 500, { priceMinor: 1_250 }),
    ])
    const before = on.provider.length
    const control = await quotedCheckout(
      on.served.baseUrl,
      onVariant,
      `control-${randomUUID()}@shop.test`,
    )
    if (control.answer.status !== 200) {
      throw new Error(`control checkout: ${JSON.stringify(control.answer.body)}`)
    }
    const created = on.provider.slice(before).filter((c) => c.method === 'createPaymentIntent')
    if (created.length !== 1) throw new Error(`control intents: ${created.length}`)
    controlKeys = Object.keys(
      (created[0]!.args[0] as { metadata?: Record<string, string> }).metadata ?? {},
    ).sort()
  }, 60_000)
  afterAll(async () => {
    await close(on)
    await close(off)
  })

  const local = HEARTBEAT_EMAIL.slice(0, HEARTBEAT_EMAIL.indexOf('@'))
  const domain = HEARTBEAT_EMAIL.slice(HEARTBEAT_EMAIL.indexOf('@') + 1)
  const near = fc.oneof(
    fc.stringMatching(/^[a-z0-9]{1,8}$/).map((tag) => `${local}+${tag}@${domain}`),
    fc.domain().map((d) => `${local}@${d}`),
    fc.domain().map((d) => `test@${d}`),
    fc.constantFrom(
      `x${HEARTBEAT_EMAIL}`,
      `${HEARTBEAT_EMAIL}.uk`,
      `<${HEARTBEAT_EMAIL}>`,
      `${HEARTBEAT_EMAIL},other@shop.test`,
      `test@${domain}`,
    ),
    fc.emailAddress(),
  )
  /** Not H after trim and lower-case, and no stub trigger that would keep the order from being paid. */
  const notH = near.filter(
    (e) =>
      e.trim().toLowerCase() !== HEARTBEAT_EMAIL.toLowerCase() &&
      !/\+stub-(pending|decline)@/.test(e),
  )

  /** One quoted checkout, the intents it created, and the order it placed. */
  async function ordinary(s: Store, variant: Seeded, email: string) {
    const before = s.provider.length
    const check = await quotedCheckout(s.served.baseUrl, variant, email)
    expect(check.answer.status, `${email}: ${JSON.stringify(check.answer.body)}`).toBe(200)
    const placed = check.answer.body.data!
    const order = (await orderByNumber(s, placed.orderNumber))!
    const intents = s.provider
      .slice(before)
      .filter((c) => c.method === 'createPaymentIntent')
      .map((c) => c.args[0] as { amountMinor: number; currency: string; metadata?: object })
    return { order, intents }
  }

  // Kills: a pattern, substring, prefix or plus-tag match, or the switch working with the feature off, so a shopper's
  // checkout is diverted; also a store with no switch at all, which the first check catches.
  it('AC-2: property: H itself is diverted on the store with the feature on; any other address there, and H with the feature off, is charged once for the order total in its currency with the control checkout’s metadata keys, keeps the cart’s source and is confirmed on the stub', async () => {
    const diverted = await quotedCheckout(on.served.baseUrl, onVariant, HEARTBEAT_EMAIL)
    expect(diverted.answer.status, JSON.stringify(diverted.answer.body)).toBe(409)
    expect(diverted.answer.body.error?.code).toBe('checkout.synthetic')

    const cases = fc.oneof(
      notH.map((email) => ({ store: 'on' as const, email })),
      fc
        .constantFrom(HEARTBEAT_EMAIL, HEARTBEAT_EMAIL.toLowerCase(), ` ${HEARTBEAT_EMAIL} `)
        .map((email) => ({ store: 'off' as const, email })),
    )
    await fc.assert(
      fc.asyncProperty(cases, async ({ store, email }) => {
        const s = store === 'on' ? on : off
        const { order, intents } = await ordinary(s, store === 'on' ? onVariant : offVariant, email)
        expect(intents, `${store}: ${email}`).toHaveLength(1)
        expect(intents[0]!.amountMinor).toBe(order.totalMinor)
        expect(intents[0]!.currency).toBe(order.currency)
        expect(Object.keys(intents[0]!.metadata ?? {}).sort()).toEqual(controlKeys)
        expect(order.source).toBe('storefront')
        expect(order.status).toBe('confirmed')
      }),
      { numRuns: 15 },
    )
  }, 120_000)
})

describe('synthetic store check: nothing downstream', () => {
  let s: Store
  let shopperVariant: Seeded
  const sent: TransactionalEmail[] = []

  beforeAll(async () => {
    s = await serve(true)
    const email = s.k.app.adapters.email
    const send = email.sendTransactional.bind(email)
    // The handler looks the method up at call time; the real (console) adapter still sends.
    email.sendTransactional = async (message) => {
      sent.push(message)
      return send(message)
    }
    shopperVariant = await seedVariant(s.k, 50, { priceMinor: 2_000 })
  }, 60_000)
  afterAll(() => close(s))

  async function delivered(): Promise<void> {
    await s.k.app.relay.drain()
    await vi.waitFor(
      async () => {
        const open = (await eventRows(s.raw)).filter(
          (r) => r.deliveredAt == null && r.deadAt == null,
        )
        expect(open.map((r) => r.type)).toEqual([])
      },
      { timeout: 10_000, interval: 20 },
    )
  }

  const lastSeq = async (): Promise<number> => {
    const rows = await eventRows(s.raw)
    return rows.length === 0 ? 0 : rows.at(-1)!.seq
  }

  // Kills: the synthetic path reaching confirm (order.paid, cart.converted, customer stats), a payment event, a stock
  // movement or restock alert, a mail; or an admin action that can still confirm a synthetic order.
  it('AC-3: property: after k store checks (k in 1..5) and one storefront order, each synthetic order has exactly its order.placed and order.cancelled, no inventory or restock event names the heartbeat variant, nothing is mailed to H, mark-paid on a synthetic order is refused 409, and the storefront order is confirmed with its own events', async () => {
    const admin = await adminClient(s.k, s.served.baseUrl)
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (k) => {
        // One unit in stock: a reservation and its release would take it to 0 and back, publishing a restock.
        const heartbeatVariant = await seedVariant(s.k, 1, { priceMinor: 1_250 })
        await delivered()
        const from = await lastSeq()
        const stockBefore = await stockOf(s, heartbeatVariant)

        const synthetic: Order[] = []
        for (let i = 0; i < k; i++) {
          const check = await quotedCheckout(s.served.baseUrl, heartbeatVariant, HEARTBEAT_EMAIL)
          expect(check.answer.status, JSON.stringify(check.answer.body)).toBe(409)
          expect(check.answer.body.error?.code).toBe('checkout.synthetic')
          synthetic.push(
            (await orderByNumber(s, contextOf(check.answer)['orderNumber'] as string))!,
          )
        }
        const buyer = `buyer-${randomUUID()}@shop.test`
        const real = await quotedCheckout(s.served.baseUrl, shopperVariant, buyer, {
          shipTo: { ...HEARTBEAT_ADDRESS, firstName: 'Real', lastName: 'Buyer' },
        })
        expect(real.answer.status, JSON.stringify(real.answer.body)).toBe(200)
        await delivered()

        const events = (await eventRows(s.raw)).filter((e) => e.seq > from)
        const naming = (id: string) =>
          events.filter((e) => JSON.stringify(e.envelope).includes(id)).map((e) => e.type)
        for (const order of synthetic) {
          expect(naming(order.id).sort(), `events naming ${order.orderNumber}`).toEqual([
            'order.cancelled.v1',
            'order.placed.v1',
          ])
        }
        const stockEvents = naming(heartbeatVariant.variantId).filter(
          (t) => t.startsWith('inventory.') || t.startsWith('product.restocked'),
        )
        expect(stockEvents).toEqual([])
        expect(await stockOf(s, heartbeatVariant)).toBe(stockBefore)
        expect(
          sent.filter((m) => m.to.trim().toLowerCase() === HEARTBEAT_EMAIL.toLowerCase()),
        ).toEqual([])

        const markPaid = await admin.call(
          'POST',
          `/api/admin/orders/${synthetic[0]!.id}/mark-paid`,
          {},
        )
        expect(markPaid.status, JSON.stringify(markPaid.body)).toBe(409)
        expect((await orderByNumber(s, synthetic[0]!.orderNumber))!.status).toBe('cancelled')

        const realOrder = (await orderByNumber(s, real.answer.body.data!.orderNumber))!
        expect(realOrder.status).toBe('confirmed')
        const realEvents = naming(realOrder.id)
        expect(realEvents).toContain('order.placed.v1')
        expect(realEvents).toContain('order.paid.v1')
        expect(sent.filter((m) => m.template === 'order-placed' && m.to === buyer)).toHaveLength(1)
      }),
      { numRuns: 3 },
    )
  }, 180_000)
})
