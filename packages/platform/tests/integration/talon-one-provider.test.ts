import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import type { Cart, PromotionEffect } from '@nymbalhq/types'
import { createTalonOnePromotionsAdapter } from '../../../adapters/promotions/talon-one/src/index.js'
import {
  FAKE_TALON_ONE_API_KEY,
  startFakeTalonOne,
  type FakeTalonOne,
} from '../../../adapters/promotions/talon-one/src/tests/fake-talon-one.js'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { createLogger } from '../../src/logger.js'
import { buildRepositories, type Repositories } from '../../src/repositories/index.js'
import {
  createPlaceQuoter,
  PROMOTIONS_BOUND_MS,
  settleInputOf,
} from '../../src/services/promotions-quote.js'
import { settleQuote } from '../../src/services/totals.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { addLine, putCode, readCart, type PricedCart, type Shop } from '../support/promotions.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'

// A store on `commerce.promotions: { provider: 'talon-one' }` with the in-process Talon.One fake behind it: the
// provider resolves from its package, a code is accepted and priced by Talon.One over HTTP without saving a session,
// checkout saves exactly one session under the order's id, paying closes it and cancelling cancels it, a code-less
// campaign applies by itself, and an outage or a missing key is the kernel's outage path. The totals invariant holds
// for whatever Talon.One answers, through the real adapter and the kernel's place quote.

const logger = createLogger({ pretty: false, level: 'silent' })

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  totalMinor: number
  currency: string
  paymentIntent: { id: string; amountMinor: number }
}

/** The kernel config with promotions on Talon.One at `baseUrl`, parsed: the schema must accept the block. */
function withTalonOne(baseUrl: string, over: Record<string, unknown> = {}) {
  return (config: NymbalConfig): NymbalConfig =>
    nymbalConfigSchema.parse({
      ...config,
      commerce: {
        ...config.commerce,
        promotions: {
          provider: 'talon-one',
          config: { baseUrl, apiKey: FAKE_TALON_ONE_API_KEY, currency: 'GBP', ...over },
        },
      },
    })
}

const pendingEmail = () => `buyer-${randomUUID()}+stub-pending@talon.test`
const uniqueCode = (prefix: string) =>
  `${prefix}${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`

function checkout(shop: Shop, email: string, shippingAddress = address) {
  return shop.call<CheckoutAnswer>('POST', '/api/checkout', {
    email,
    billingAddress: address,
    shippingAddress,
  })
}

async function shopWithLine(served: ServedKernel, seeded: Seeded, qty: number): Promise<Shop> {
  const shop = await primedShopper(served.baseUrl)
  expect((await readCart(shop)).status).toBe(200)
  const added = await addLine(shop, seeded, qty)
  expect(added.status, JSON.stringify(added.body)).toBe(200)
  return shop
}

const ordersBy = (raw: RawReader, email: string) => raw.count('orders', 'email = ?', [email])

describe('AC-12: the totals invariant holds whatever Talon.One answers', () => {
  let store: CommandStore
  let repos: Repositories
  let fake: FakeTalonOne

  beforeAll(async () => {
    store = createCommandStore(
      // @ts-expect-error a minimal config: only the command store kind is read
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'talon', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    await runMigrations(store, {
      migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
    })
    repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    fake = await startFakeTalonOne()
  })

  afterAll(async () => {
    await fake?.close()
    await store?.close()
  })

  const arbLines = fc.array(
    fc.record({
      priceMinor: fc.integer({ min: 0, max: 10_000_000 }),
      qty: fc.integer({ min: 1, max: 9 }),
    }),
    { minLength: 1, maxLength: 5 },
  )
  // Major units, past any line or cart, with fractions of a minor unit.
  const arbValue = fc.double({ min: 0, max: 2_000_000, noNaN: true }).map((v) => v + 0)
  const arbAnswer = fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant('order' as const), value: arbValue }),
      fc.record({
        kind: fc.constant('item' as const),
        value: arbValue,
        position: fc.integer({ min: 0, max: 5 }),
      }),
    ),
    { maxLength: 6 },
  )

  it('AC-12: for generated carts and Talon.One answers, total = subtotal − discount + shipping + tax, each line’s discount within its subtotal, the discounts add up to the applied amounts, the total is never negative, and the discount is what the answer’s rounded amounts settle to', async () => {
    const adapter = createTalonOnePromotionsAdapter({
      logger,
      config: { baseUrl: fake.baseUrl, apiKey: FAKE_TALON_ONE_API_KEY, currency: 'GBP' },
    })
    await adapter.initialize({
      baseUrl: fake.baseUrl,
      apiKey: FAKE_TALON_ONE_API_KEY,
      currency: 'GBP',
    })
    const quoter = createPlaceQuoter({
      store,
      catalogue: repos,
      engine: adapter,
      boundMs: PROMOTIONS_BOUND_MS,
      onUnavailable: 'refuse',
      logger,
    })

    await fc.assert(
      fc.asyncProperty(arbLines, arbAnswer, async (lines, answer) => {
        const tag = randomUUID()
        const now = new Date().toISOString()
        const cart: Cart = {
          token: `cart-${tag}`,
          customerId: null,
          items: lines.map((l, i) => ({
            variantId: `variant-${tag}-${i}`,
            productId: `product-${tag}-${i}`,
            productName: 'Generated',
            variantName: 'Default',
            priceMinor: l.priceMinor,
            qty: l.qty,
            imageUrl: '',
          })),
          subtotalMinor: lines.reduce((sum, l) => sum + l.priceMinor * l.qty, 0),
          currency: 'GBP',
          source: 'storefront',
          expiresAt: now,
          createdAt: now,
          updatedAt: now,
          promotions: {
            codes: ['GENERATED'],
            effects: [],
            provider: 'talon-one',
            evaluatedAt: now,
            unavailable: false,
          },
        }
        fake.answer({
          status: 200,
          body: {
            customerSession: { state: 'open' },
            coupons: [],
            createdCoupons: [],
            effects: answer.map((a, i) => ({
              campaignId: 40 + i,
              rulesetId: 400 + i,
              ruleIndex: 0,
              ruleName: `rule ${i}`,
              effectType: a.kind === 'order' ? 'setDiscount' : 'setDiscountPerItem',
              props:
                a.kind === 'order'
                  ? { name: `Order ${i}`, value: a.value }
                  : { name: `Item ${i}`, value: a.value, position: a.position, subPosition: 0 },
            })),
          },
        })

        const { totals } = await quoter.dry(cart, { customerId: null })

        const tax = totals.pricesIncludeTax ? 0 : totals.taxTotalMinor
        expect(totals.totalMinor).toBe(
          totals.subtotalMinor - totals.discountTotalMinor + totals.shippingTotalMinor + tax,
        )
        for (const line of totals.lines) {
          expect(line.discountMinor).toBeGreaterThanOrEqual(0)
          expect(line.discountMinor).toBeLessThanOrEqual(line.subtotalMinor)
        }
        const lineDiscounts = totals.lines.reduce((sum, l) => sum + l.discountMinor, 0)
        const applied = totals.applied.reduce(
          (sum, e) => sum + ('amountMinor' in e ? e.amountMinor : 0),
          0,
        )
        expect(lineDiscounts + totals.shippingDiscountMinor).toBe(totals.discountTotalMinor)
        expect(totals.discountTotalMinor).toBe(applied)
        expect(totals.totalMinor).toBeGreaterThanOrEqual(0)
        // Not vacuous: the money is the answer's, each amount rounded to minor units, settled by the kernel's rule.
        const expected: PromotionEffect[] = answer.flatMap((a, i): PromotionEffect[] => {
          const amountMinor = Math.round(a.value * 100)
          if (a.kind === 'order') return [{ kind: 'order', amountMinor, label: `Order ${i}` }]
          const lineId = cart.items[a.position]?.variantId
          return lineId === undefined
            ? []
            : [{ kind: 'line', lineId, amountMinor, label: `Item ${i}` }]
        })
        const settled = settleQuote(settleInputOf(cart, expected, false)).totals
        expect(totals.discountTotalMinor).toBe(settled.discountTotalMinor)
        expect(totals.lines.map((l) => l.discountMinor)).toEqual(
          settled.lines.map((l) => l.discountMinor),
        )
      }),
      { numRuns: 50 },
    )
  })
})

describe('the talon-one provider on a served store', () => {
  let fake: FakeTalonOne
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    fake = await startFakeTalonOne()
    k = await createKernel({ dialect: 'sqlite', configure: withTalonOne(fake.baseUrl) })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
    await fake?.close()
  })

  /** A cart of `qty` × a fresh variant at `priceMinor` with `code` added, as the shopper's code route answered it. */
  async function codedCart(code: string, priceMinor = 2000, qty = 2) {
    const seeded = await seedVariant(k, 50, { priceMinor })
    const shop = await shopWithLine(served, seeded, qty)
    const added = await putCode(shop, code)
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    return { shop, seeded, cart: added.body.data! }
  }

  describe('AC-13: codes, checkout and campaigns are Talon.One’s', () => {
    it('AC-13: POST /api/cart/codes with a code the fake discounts 10% answers the code accepted and the discounted totals, and saves no session at Talon.One', async () => {
      const code = uniqueCode('TEN')
      fake.coupons([{ code, percent: 10 }])
      const savedBefore = fake.sessions.size

      const { cart } = await codedCart(code)

      expect(k.app.adapters.promotions.providerName).toBe('talon-one')
      expect(cart.promotions.codes).toEqual([{ code, status: 'accepted' }])
      const subtotal = cart.items.reduce((sum, i) => sum + i.priceMinor * i.qty, 0)
      expect(cart.totals.subtotalMinor).toBe(subtotal)
      expect(cart.totals.discountTotalMinor).toBe(Math.round((subtotal * 10) / 100))
      expect(cart.totals.totalMinor).toBe(subtotal - cart.totals.discountTotalMinor)
      expect(fake.sessions.size).toBe(savedBefore)
    })

    it('AC-13: POST /api/checkout makes the order at the discounted total, recorded as talon-one, and Talon.One holds one new session under the order’s id, open, with the cart’s items and code', async () => {
      const code = uniqueCode('TEN')
      fake.coupons([{ code, percent: 10 }])
      const { shop, seeded, cart } = await codedCart(code, 1500, 3)
      const savedBefore = [...fake.sessions.keys()]

      const res = await checkout(shop, pendingEmail())

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const { orderId, totalMinor } = res.body.data!
      expect(totalMinor).toBe(cart.totals.totalMinor)
      expect(totalMinor).toBeLessThan(cart.totals.subtotalMinor)
      const order = await k.store.read((tx) => k.repos.order.findById(tx, orderId))
      expect(order!.metadata).toMatchObject({
        promotions: { provider: 'talon-one', codes: [code] },
      })
      expect([...fake.sessions.keys()]).toEqual([...savedBefore, orderId])
      const variant = await k.store.read((tx) => k.repos.variant.findById(tx, seeded.variantId))
      const session = fake.sessions.get(orderId)!
      expect(session.state).toBe('open')
      expect(session.couponCodes).toEqual([code])
      expect(session.cartItems).toEqual([{ sku: variant!.sku, quantity: 3, price: 15 }])
    })

    it('AC-13: a code-less campaign discounts a cart with no code', async () => {
      fake.campaigns([{ name: 'House five', percent: 5 }])
      try {
        const seeded = await seedVariant(k, 50, { priceMinor: 3000 })
        const shop = await shopWithLine(served, seeded, 2)

        const cart = (await readCart(shop)).body.data! as PricedCart

        expect(cart.promotions.codes).toEqual([])
        expect(cart.totals.discountTotalMinor).toBe(
          Math.round((cart.totals.subtotalMinor * 5) / 100),
        )
        expect(cart.totals.totalMinor).toBe(
          cart.totals.subtotalMinor - cart.totals.discountTotalMinor,
        )
      } finally {
        fake.campaigns([])
      }
    })
  })

  describe('AC-14: paying closes the order’s own session, cancelling cancels it', () => {
    it('AC-14: a paid order’s session is closed once and its code counted once; a second order cancelled before payment cancels only its own session; the same cart placed again opens a third session under the new order’s id', async () => {
      const code = uniqueCode('PAY')
      fake.coupons([{ code, percent: 10 }])

      const first = await codedCart(code)
      const placed = await checkout(first.shop, pendingEmail())
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      const one = placed.body.data!
      const done = await k.services.checkout.finalize(one.paymentIntent.id, {
        amountMinor: one.totalMinor,
        currency: one.currency,
      })
      expect(done.finalized, JSON.stringify(done)).toBe(true)
      await vi.waitFor(() => expect(fake.sessions.get(one.orderId)?.state).toBe('closed'), {
        timeout: 10_000,
        interval: 20,
      })

      const second = await codedCart(code)
      const email = pendingEmail()
      const twoRes = await checkout(second.shop, email)
      expect(twoRes.status, JSON.stringify(twoRes.body)).toBe(200)
      const two = twoRes.body.data!
      // A changed address cancels the pending order and places the same cart again.
      const threeRes = await checkout(second.shop, email, { ...address, postalCode: 'N1 9GU' })
      expect(threeRes.status, JSON.stringify(threeRes.body)).toBe(200)
      const three = threeRes.body.data!
      await vi.waitFor(() => expect(fake.sessions.get(two.orderId)?.state).toBe('cancelled'), {
        timeout: 10_000,
        interval: 20,
      })
      await k.app.relay.drain()

      const status = await raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [
        two.orderId,
      ])
      expect(status.status).toBe('cancelled')
      expect(three.orderId).not.toBe(two.orderId)
      expect(
        [one.orderId, two.orderId, three.orderId].map((id) => fake.sessions.get(id)?.state),
      ).toEqual(['closed', 'cancelled', 'open'])
      expect(fake.sessions.get(one.orderId)!.stateSets.closed).toBe(1)
      expect(fake.sessions.get(two.orderId)!.stateSets.cancelled).toBe(1)
      expect(fake.uses(code)).toBe(1)
    })

    it('AC-14: an order with no code that Talon.One discounted nothing still has its session closed when paid, and one cancelled has its own cancelled', async () => {
      const paidShop = await shopWithLine(served, await seedVariant(k, 50, { priceMinor: 1800 }), 2)
      const paidRes = await checkout(paidShop, pendingEmail())
      expect(paidRes.status, JSON.stringify(paidRes.body)).toBe(200)
      const paid = paidRes.body.data!
      const paidOrder = await k.store.read((tx) => k.repos.order.findById(tx, paid.orderId))
      expect(paidOrder!.discountTotalMinor).toBe(0)
      expect(paidOrder!.subtotalMinor).toBe(1800 * 2)
      expect(fake.sessions.get(paid.orderId)?.state).toBe('open')
      const done = await k.services.checkout.finalize(paid.paymentIntent.id, {
        amountMinor: paid.totalMinor,
        currency: paid.currency,
      })
      expect(done.finalized, JSON.stringify(done)).toBe(true)

      const email = pendingEmail()
      const otherShop = await shopWithLine(
        served,
        await seedVariant(k, 50, { priceMinor: 1800 }),
        1,
      )
      const cancelledRes = await checkout(otherShop, email)
      expect(cancelledRes.status, JSON.stringify(cancelledRes.body)).toBe(200)
      const cancelled = cancelledRes.body.data!
      // A changed address cancels the pending order and places the same cart again.
      const againRes = await checkout(otherShop, email, { ...address, postalCode: 'N1 9GU' })
      expect(againRes.status, JSON.stringify(againRes.body)).toBe(200)
      const again = againRes.body.data!

      await vi.waitFor(
        () =>
          expect(
            [paid.orderId, cancelled.orderId, again.orderId].map(
              (id) => fake.sessions.get(id)?.state,
            ),
          ).toEqual(['closed', 'cancelled', 'open']),
        { timeout: 10_000, interval: 20 },
      )
      expect(fake.sessions.get(paid.orderId)!.couponCodes).toEqual([])
      expect(fake.sessions.get(paid.orderId)!.stateSets.closed).toBe(1)
      expect(fake.sessions.get(cancelled.orderId)!.stateSets.cancelled).toBe(1)
    })
  })
})

describe('AC-15: a Talon.One outage, or no API key, is the kernel’s outage path', () => {
  const TIMEOUT_MS = 200

  describe('AC-15: Talon.One hanging', () => {
    let fake: FakeTalonOne
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader

    beforeAll(async () => {
      fake = await startFakeTalonOne()
      k = await createKernel({
        dialect: 'sqlite',
        configure: withTalonOne(fake.baseUrl, { timeoutMs: TIMEOUT_MS }),
      })
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      fake?.answer(null)
      await raw?.close()
      await served?.stop()
      await fake?.close()
    })

    it('AC-15: adding a code answers 503 cart.promotions_unavailable inside the kernel’s bound and leaves the cart as it was; checkout of a cart holding a code answers 503 checkout.promotions_unavailable and makes no order', async () => {
      const code = uniqueCode('OUT')
      fake.coupons([{ code, percent: 10 }])
      const coded = await shopWithLine(served, await seedVariant(k, 50, { priceMinor: 2000 }), 1)
      expect((await putCode(coded, code)).status).toBe(200)
      const plain = await shopWithLine(served, await seedVariant(k, 50, { priceMinor: 2000 }), 1)
      const before = (await readCart(plain)).body.data!
      const email = pendingEmail()
      fake.answer('hang')
      try {
        const started = Date.now()
        const added = await putCode(plain, code)
        const ms = Date.now() - started
        const after = (await readCart(plain)).body.data!
        const placed = await checkout(coded, email)

        expect(added.status, JSON.stringify(added.body)).toBe(503)
        expect(added.body.error?.code).toBe('cart.promotions_unavailable')
        expect(ms).toBeLessThan(PROMOTIONS_BOUND_MS)
        expect(after.promotions.codes).toEqual(before.promotions.codes)
        expect(after.items).toEqual(before.items)
        expect(after.totals).toEqual(before.totals)
        expect(placed.status, JSON.stringify(placed.body)).toBe(503)
        expect(placed.body.error?.code).toBe('checkout.promotions_unavailable')
        expect(await ordersBy(raw, email)).toBe(0)
      } finally {
        fake.answer(null)
      }
    })
  })

  describe('AC-15: the API key set nowhere', () => {
    let fake: FakeTalonOne
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader

    beforeAll(async () => {
      fake = await startFakeTalonOne()
      k = await createKernel({
        dialect: 'sqlite',
        configure: (config) => {
          const parsed = withTalonOne(fake.baseUrl)(config)
          const block = { ...parsed.commerce.promotions.config }
          delete block['apiKey']
          return {
            ...parsed,
            commerce: {
              ...parsed.commerce,
              promotions: { ...parsed.commerce.promotions, config: block },
            },
          }
        },
      })
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
      await fake?.close()
    })

    it('AC-15: the store boots, a cart with no code places at full price, adding a code answers 503 cart.promotions_unavailable, and nothing reaches Talon.One', async () => {
      const seeded = await seedVariant(k, 50, { priceMinor: 2500 })
      const shop = await shopWithLine(served, seeded, 2)
      const email = pendingEmail()

      const placed = await checkout(shop, email)
      const other = await shopWithLine(served, await seedVariant(k, 50, { priceMinor: 2500 }), 1)
      const added = await putCode(other, uniqueCode('NOKEY'))

      expect(k.app.adapters.promotions.providerName).toBe('talon-one')
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      expect(placed.body.data!.totalMinor).toBe(seeded.priceMinor * 2)
      expect(await ordersBy(raw, email)).toBe(1)
      expect(added.status, JSON.stringify(added.body)).toBe(503)
      expect(added.body.error?.code).toBe('cart.promotions_unavailable')
      expect(fake.requests).toEqual([])
    })
  })
})
