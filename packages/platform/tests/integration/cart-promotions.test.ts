import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { EVT_CART_UPDATED, type PromotionSession, type PromotionsAdapter } from '@nymbalhq/types'
import { settleTotals } from '../../src/services/totals.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import {
  addLine,
  linesSubtotal,
  putCode,
  readCart,
  scriptedEngine,
  seedPromotion,
  uniqueCode,
  type PricedCart,
  type ScriptedEngine,
  type Shop,
} from '../support/promotions.js'
import { openRaw, type RawReader, writeRaw } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import { writeAuditViolations } from '../support/write-audit.js'

// Codes on a cart over HTTP on a served kernel (SQLite): the native engine for the store's own behaviour, a scripted
// engine in the `custom` slot where a test needs an outage or a count of engine calls.

const CART_COOKIE = 'nymbal.cart'
const PASSWORD = 'cart-codes-correct-horse'

let k: Kernel
let served: ServedKernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

function withScriptedSlot(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: { ...config.commerce, promotions: { provider: 'custom', onUnavailable: 'proceed' } },
  } as NymbalConfig
}

interface Scripted {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  engine: ScriptedEngine
}

let scriptedStore: Promise<Scripted> | undefined

/** A kernel whose promotions engine a test scripts. Built on first use, so each test that needs it fails on its own. */
function scripted(): Promise<Scripted> {
  scriptedStore ??= (async () => {
    const engine = scriptedEngine()
    const kernel = await createKernel({
      dialect: 'sqlite',
      configure: withScriptedSlot,
      appOptions: { adapters: { promotions: engine.adapter } },
    })
    const server = await serveKernel(kernel)
    return { k: kernel, served: server, raw: openRaw(kernel.dialect, kernel.target), engine }
  })()
  return scriptedStore
}

afterAll(async () => {
  const built = await scriptedStore?.catch(() => undefined)
  await built?.raw.close()
  await built?.served.stop()
})

async function freshShop(baseUrl = served.baseUrl): Promise<Shop> {
  const shop = await primedShopper(baseUrl)
  expect((await readCart(shop)).status).toBe(200)
  return shop
}

async function reload(shop: Shop, baseUrl = served.baseUrl): Promise<PricedCart> {
  // A second client on the same cookies: only what the server kept comes back.
  const again = await primedShopper(baseUrl, new Map(shop.jar))
  const res = await readCart(again)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

/** The cart's `promotions` column as committed: parsed on SQLite, already an object on Postgres. */
async function storedPromotions(reader: RawReader, token: string): Promise<unknown> {
  const row = await reader.one<{ promotions: unknown }>(
    'SELECT promotions FROM carts WHERE token = ?',
    [token],
  )
  return typeof row.promotions === 'string' ? JSON.parse(row.promotions) : row.promotions
}

describe('AC-9: a code on the cart', () => {
  it('AC-9: a valid code answers the cart with the code accepted, the engine’s discount and total = subtotal − discount, and a reload shows the same', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 50_000 }),
        fc.integer({ min: 1, max: 6 }),
        async (bps, priceMinor, qty) => {
          const code = uniqueCode('SAVE')
          await seedPromotion(k, { code, kind: 'percent', percentBps: bps })
          const seeded = await seedVariant(k, 50, { priceMinor })
          const shop = await freshShop()
          await addLine(shop, seeded, qty)

          const res = await putCode(shop, code)

          expect(res.status, JSON.stringify(res.body)).toBe(200)
          const cart = res.body.data!
          const subtotal = priceMinor * qty
          const engineAmount = Number((BigInt(subtotal) * BigInt(bps)) / 10_000n)
          expect(cart.promotions.codes).toEqual([{ code, status: 'accepted' }])
          expect(cart.totals.subtotalMinor).toBe(subtotal)
          expect(cart.totals.discountTotalMinor).toBe(engineAmount)
          expect(cart.totals.totalMinor).toBe(subtotal - cart.totals.discountTotalMinor)

          const after = await reload(shop)
          expect(after.totals).toEqual(cart.totals)
          expect(after.promotions).toEqual(cart.promotions)
        },
      ),
      { numRuns: 8 },
    )
  })
})

describe('AC-10: the code list', () => {
  async function cartWithLine(): Promise<{ shop: Shop; cart: PricedCart }> {
    const seeded = await seedVariant(k, 50, { priceMinor: 2000 })
    const shop = await freshShop()
    const added = await addLine(shop, seeded, 1)
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    return { shop, cart: added.body.data! }
  }

  it('AC-10: a rejected code answers 200, is kept with its reason and leaves the totals undiscounted', async () => {
    const { shop } = await cartWithLine()
    const code = uniqueCode('NOPE')

    const res = await putCode(shop, code)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const cart = res.body.data!
    expect(cart.promotions.codes).toEqual([{ code, status: 'rejected', reason: 'unknown' }])
    expect(cart.totals.discountTotalMinor).toBe(0)
    expect(cart.totals.totalMinor).toBe(cart.totals.subtotalMinor)
    expect((await reload(shop)).promotions.codes).toEqual(cart.promotions.codes)
  })

  it('AC-10: DELETE removes a code in any case and the discount with it; a code not on the cart is a no-op 200', async () => {
    const { shop } = await cartWithLine()
    const code = uniqueCode('Del')
    await seedPromotion(k, { code, kind: 'percent', percentBps: 1000 })
    const added = await putCode(shop, code)
    expect(added.body.data!.totals.discountTotalMinor).toBeGreaterThan(0)

    const removed = await shop.call<PricedCart>(
      'DELETE',
      `/api/cart/codes/${code.toUpperCase() === code ? code.toLowerCase() : code.toUpperCase()}`,
    )

    expect(removed.status, JSON.stringify(removed.body)).toBe(200)
    expect(removed.body.data!.promotions.codes).toEqual([])
    expect(removed.body.data!.totals.discountTotalMinor).toBe(0)

    const again = await shop.call<PricedCart>('DELETE', `/api/cart/codes/${uniqueCode('ABSENT')}`)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data!.promotions.codes).toEqual([])
  })

  it('AC-10: a code already on the cart in another case is not added twice', async () => {
    const { shop } = await cartWithLine()
    const code = uniqueCode('Dupe')
    await seedPromotion(k, { code, kind: 'percent', percentBps: 1000 })
    await putCode(shop, code)

    const res = await putCode(
      shop,
      code.toLowerCase() === code ? code.toUpperCase() : code.toLowerCase(),
    )

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data!.promotions.codes).toHaveLength(1)
  })

  it('AC-10: a sixth code is cart.code_limit and the list stays at five', async () => {
    const { shop } = await cartWithLine()
    const five = Array.from({ length: 5 }, () => uniqueCode('LIM'))
    for (const code of five) {
      expect((await putCode(shop, code)).status).toBe(200)
    }

    const sixth = await putCode(shop, uniqueCode('LIM'))

    expect(sixth.status, JSON.stringify(sixth.body)).toBe(400)
    expect(sixth.body.error?.code).toBe('cart.code_limit')
    expect((await reload(shop)).promotions.codes.map((c) => c.code)).toEqual(five)
  })

  it('AC-10: a blank or over-long code is cart.code_invalid and changes nothing; a request with no cart is cart.missing', async () => {
    const { shop } = await cartWithLine()
    const before = await reload(shop)

    for (const code of ['   ', 'x'.repeat(65)]) {
      const res = await putCode(shop, code)
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.error?.code).toBe('cart.code_invalid')
    }
    expect((await reload(shop)).promotions).toEqual(before.promotions)

    const noCart = await primedShopper(served.baseUrl)
    const res = await putCode(noCart, 'ANY')
    expect(res.status, JSON.stringify(res.body)).toBe(404)
    expect(res.body.error?.code).toBe('cart.missing')
  })
})

describe('AC-11: the totals follow the cart', () => {
  const VARIANTS = 3
  const MINIMUM = 4000

  type Op =
    | { kind: 'add'; index: number; qty: number }
    | { kind: 'qty'; index: number; qty: number }
    | { kind: 'remove'; index: number }

  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant('add' as const),
      index: fc.nat({ max: VARIANTS - 1 }),
      qty: fc.integer({ min: 1, max: 3 }),
    }),
    fc.record({
      kind: fc.constant('qty' as const),
      index: fc.nat({ max: VARIANTS - 1 }),
      qty: fc.integer({ min: 1, max: 4 }),
    }),
    fc.record({ kind: fc.constant('remove' as const), index: fc.nat({ max: VARIANTS - 1 }) }),
  )

  async function apply(shop: Shop, variants: readonly Seeded[], op: Op): Promise<void> {
    const seeded = variants[op.index]!
    const cart = (await readCart(shop)).body.data!
    const present = cart.items.some((item) => item.variantId === seeded.variantId)
    const res =
      op.kind === 'add' || !present
        ? await addLine(shop, seeded, op.kind === 'remove' ? 1 : op.qty)
        : op.kind === 'qty'
          ? await shop.call('PATCH', `/api/cart/items/${seeded.variantId}`, { qty: op.qty })
          : await shop.call('DELETE', `/api/cart/items/${seeded.variantId}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  }

  it('AC-11: after every add, change-quantity and remove, GET /api/cart’s totals are settleTotals over the lines and a fresh dry evaluation, and the minimum decides the discount', async () => {
    const adapter = k.app.adapters.promotions as PromotionsAdapter
    await fc.assert(
      fc.asyncProperty(fc.array(arbOp, { minLength: 1, maxLength: 6 }), async (ops) => {
        const code = uniqueCode('STEP')
        await seedPromotion(k, {
          code,
          kind: 'percent',
          percentBps: 1500,
          minimumSubtotalMinor: MINIMUM,
          currency: 'GBP',
        })
        const variants = await Promise.all(
          Array.from({ length: VARIANTS }, (_, i) =>
            seedVariant(k, 500, { priceMinor: 1000 + i * 700 }),
          ),
        )
        const shop = await freshShop()
        await addLine(shop, variants[0]!, 1)
        expect((await putCode(shop, code)).status).toBe(200)

        for (const op of ops) {
          await apply(shop, variants, op)
          const cart = (await readCart(shop)).body.data!
          const session: PromotionSession = {
            id: cart.token,
            customerId: null,
            codes: [code],
            currency: cart.currency,
            lines: cart.items.map((item) => ({
              id: item.variantId,
              variantId: item.variantId,
              sku: '',
              productId: item.productId,
              categoryIds: [],
              unitMinor: item.priceMinor,
              qty: item.qty,
            })),
            shipping: null,
          }
          const { effects } = await adapter.evaluate(session, { dry: true })
          const expected = settleTotals({
            currency: cart.currency,
            lines: cart.items.map((item) => ({
              id: item.variantId,
              unitMinor: item.priceMinor,
              qty: item.qty,
            })),
            shipping: null,
            effects,
            tax: null,
            pricesIncludeTax: false,
          })

          expect(cart.totals).toEqual(expected)
          const subtotal = linesSubtotal(cart)
          expect(cart.totals.discountTotalMinor > 0, `subtotal ${subtotal}`).toBe(
            subtotal >= MINIMUM,
          )
        }
      }),
      { numRuns: 8 },
    )
  })

  it('AC-11: a cart dropping below the minimum loses the discount, and climbing back regains it', async () => {
    const code = uniqueCode('EDGE')
    await seedPromotion(k, {
      code,
      kind: 'percent',
      percentBps: 1000,
      minimumSubtotalMinor: 3000,
      currency: 'GBP',
    })
    const seeded = await seedVariant(k, 50, { priceMinor: 1000 })
    const shop = await freshShop()
    await addLine(shop, seeded, 3)
    await putCode(shop, code)
    const above = (await readCart(shop)).body.data!.totals.discountTotalMinor
    expect(above).toBe(300)

    await shop.call('PATCH', `/api/cart/items/${seeded.variantId}`, { qty: 2 })
    const below = (await readCart(shop)).body.data!
    expect(below.totals.discountTotalMinor).toBe(0)
    expect(below.totals.totalMinor).toBe(below.totals.subtotalMinor)
    expect(below.promotions.codes[0]!.status).toBe('rejected')

    await shop.call('PATCH', `/api/cart/items/${seeded.variantId}`, { qty: 3 })
    const back = (await readCart(shop)).body.data!
    expect(back.totals.discountTotalMinor).toBe(above)
    expect(back.promotions.codes[0]!.status).toBe('accepted')
  })
})

describe('AC-12: a cart with no code does not call the engine', () => {
  it('AC-12: an engine without automatic is never called on any cart or checkout command of a cart with no code; the cart stores no promotions and its order has none', async () => {
    const { k: kernel, served: server, raw: reader, engine } = await scripted()
    const seeded = await seedVariant(kernel, 20, { priceMinor: 1500 })
    const callsBefore = engine.calls.length
    const shop = await freshShop(server.baseUrl)
    const cart = (await addLine(shop, seeded, 2)).body.data!
    await shop.call('PATCH', `/api/cart/items/${seeded.variantId}`, { qty: 1 })
    await shop.call('POST', '/api/cart/items', { variantId: seeded.variantId, qty: 1 })

    const stored = await storedPromotions(reader, cart.token)

    const checkout = await shop.call<{ orderId: string }>('POST', '/api/checkout', {
      email: `plain-${randomUUID()}+stub-pending@promo.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200)

    expect(stored).toBeNull()
    const order = await kernel.store.read((tx) =>
      kernel.repos.order.findById(tx, checkout.body.data!.orderId),
    )
    expect(order!.metadata).not.toHaveProperty('promotions')
    expect(order!.discountTotalMinor).toBe(0)
    expect(order!.totalMinor).toBe(order!.subtotalMinor)
    expect(engine.calls.length).toBe(callsBefore)
  })
})

describe('AC-13: never a guessed discount on a cart', () => {
  async function codedCart(): Promise<{
    kernel: Kernel
    baseUrl: string
    reader: RawReader
    engine: ScriptedEngine
    shop: Shop
    seeded: Seeded
    cart: PricedCart
    code: string
  }> {
    const { k: kernel, served: server, raw: reader, engine } = await scripted()
    engine.recover()
    const seeded = await seedVariant(kernel, 20, { priceMinor: 2000 })
    const shop = await freshShop(server.baseUrl)
    await addLine(shop, seeded, 2)
    const code = uniqueCode('OUTAGE')
    const added = await putCode(shop, code)
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect(added.body.data!.totals.discountTotalMinor).toBe(400)
    return {
      kernel,
      baseUrl: server.baseUrl,
      reader,
      engine,
      shop,
      seeded,
      cart: added.body.data!,
      code,
    }
  }

  it('AC-13: POST /api/cart/codes with the engine failing answers 503 cart.promotions_unavailable and leaves the cart as it was', async () => {
    const { baseUrl, engine, shop, cart } = await codedCart()
    engine.fail()
    try {
      const res = await putCode(shop, uniqueCode('LATER'))

      expect(res.status, JSON.stringify(res.body)).toBe(503)
      expect(res.body.error?.code).toBe('cart.promotions_unavailable')
      const after = await reload(shop, baseUrl)
      expect(after.promotions).toEqual(cart.promotions)
      expect(after.totals).toEqual(cart.totals)
    } finally {
      engine.recover()
    }
  })

  it('AC-13: a cart write on a coded cart with the engine failing succeeds with promotions.unavailable, the code pending and no discount, never the last known one', async () => {
    const { engine, shop, seeded, code } = await codedCart()
    engine.fail()
    try {
      const res = await shop.call<PricedCart>('PATCH', `/api/cart/items/${seeded.variantId}`, {
        qty: 3,
      })

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const cart = res.body.data!
      expect(cart.promotions.unavailable).toBe(true)
      expect(cart.promotions.codes).toEqual([{ code, status: 'pending' }])
      expect(cart.totals.discountTotalMinor).toBe(0)
      expect(cart.totals.totalMinor).toBe(cart.totals.subtotalMinor)
    } finally {
      engine.recover()
    }
  })

  it('AC-13: GET /api/cart on a cart stored unavailable re-evaluates and stores the result, writing only the promotions column: no timestamp moves and no cart.updated is published', async () => {
    const { reader, kernel, baseUrl, engine, shop, seeded, cart } = await codedCart()
    engine.fail()
    try {
      await shop.call('PATCH', `/api/cart/items/${seeded.variantId}`, { qty: 3 })
    } finally {
      engine.recover()
    }
    expect((await storedPromotions(reader, cart.token)) as { unavailable: boolean }).toMatchObject({
      unavailable: true,
    })
    const notified = new Date(Date.now() - 3_600_000).toISOString()
    await writeRaw(
      kernel.dialect,
      kernel.target,
      'UPDATE carts SET abandoned_notified_at = ? WHERE token = ?',
      [notified, cart.token],
    )
    const timestamps = () =>
      reader.one<{ updated_at: string; expires_at: string; abandoned_notified_at: string }>(
        'SELECT updated_at, expires_at, abandoned_notified_at FROM carts WHERE token = ?',
        [cart.token],
      )
    const updatedEvents = async () =>
      (await eventRows(reader, 'type = ?', [EVT_CART_UPDATED])).filter(
        (e) => (e.envelope as { payload: { cartId: string } }).payload.cartId === cart.token,
      ).length
    const timesBefore = await timestamps()
    const eventsBefore = await updatedEvents()

    const res = await readCart(await primedShopper(baseUrl, new Map(shop.jar)))

    // The one cart write that publishes nothing: exactly this update, so the audit stays strict for every other write.
    expect(writeAuditViolations().map((v) => [v.rule, v.tables])).toEqual([
      ['domain change with no event', { carts: { update: 1 } }],
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const after = res.body.data!
    expect(after.promotions.unavailable).toBe(false)
    expect(after.totals.discountTotalMinor).toBe(Math.floor((2000 * 3) / 10))
    expect((await storedPromotions(reader, cart.token)) as { unavailable: boolean }).toMatchObject({
      unavailable: false,
    })
    expect(await timestamps()).toEqual(timesBefore)
    expect(await updatedEvents()).toBe(eventsBefore)
  })

  it('AC-13: GET /api/cart while the engine is still down keeps the cart unavailable and undiscounted', async () => {
    const { baseUrl, engine, shop, seeded } = await codedCart()
    engine.fail()
    try {
      await shop.call('PATCH', `/api/cart/items/${seeded.variantId}`, { qty: 3 })

      const res = await readCart(await primedShopper(baseUrl, new Map(shop.jar)))

      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.data!.promotions.unavailable).toBe(true)
      expect(res.body.data!.totals.discountTotalMinor).toBe(0)
    } finally {
      engine.recover()
    }
  })
})

describe('AC-14: a code at sign-in', () => {
  async function customer(): Promise<{ id: string; email: string }> {
    const email = `signin-${randomUUID()}@promo.test`
    const { customer: created } = await k.services.auth.register({ email, password: PASSWORD })
    return { id: created.id, email }
  }

  async function signInAs(shop: Shop, email: string): Promise<void> {
    const res = await shop.call('POST', '/api/auth/login', { email, password: PASSWORD })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  }

  async function customerCartWith(
    customerId: string,
    seeded: Seeded,
    code?: string,
  ): Promise<void> {
    const cart = await k.services.cart.getOrCreate(undefined, customerId)
    await k.services.cart.addItem(cart.token, {
      variantId: seeded.variantId,
      productId: seeded.productId,
      productName: 'Widget',
      variantName: 'Default',
      priceMinor: seeded.priceMinor,
      imageUrl: '',
      qty: 1,
    })
    if (code === undefined) return
    const owner = await primedShopper(served.baseUrl, new Map([[CART_COOKIE, cart.token]]))
    const res = await putCode(owner, code)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  }

  async function percent(bps: number): Promise<string> {
    const code = uniqueCode('IN')
    await seedPromotion(k, { code, kind: 'percent', percentBps: bps })
    return code
  }

  it('AC-14: the kept cart keeps its own code, and its discount is taken over the merged lines', async () => {
    const keptCode = await percent(1000)
    const guestCode = await percent(2000)
    const { id, email } = await customer()
    const a = await seedVariant(k, 20, { priceMinor: 3000 })
    const b = await seedVariant(k, 20, { priceMinor: 1700 })
    await customerCartWith(id, a, keptCode)
    const shop = await freshShop()
    await addLine(shop, b, 1)
    expect((await putCode(shop, guestCode)).status).toBe(200)

    await signInAs(shop, email)

    const cart = (await readCart(shop)).body.data!
    expect(cart.items).toHaveLength(2)
    expect(cart.promotions.codes.map((c) => c.code)).toEqual([keptCode])
    const merged = linesSubtotal(cart)
    expect(cart.totals.discountTotalMinor).toBe(Math.floor((merged * 1000) / 10_000))
    expect(cart.totals.totalMinor).toBe(merged - cart.totals.discountTotalMinor)
  })

  it('AC-14: a kept cart with no code takes the guest’s, re-evaluated: the discount is the guest code’s over the merged lines', async () => {
    const guestCode = await percent(2500)
    const { id, email } = await customer()
    const a = await seedVariant(k, 20, { priceMinor: 4100 })
    const b = await seedVariant(k, 20, { priceMinor: 900 })
    await customerCartWith(id, a)
    const shop = await freshShop()
    await addLine(shop, b, 2)
    const guest = (await putCode(shop, guestCode)).body.data!

    await signInAs(shop, email)

    const cart = (await readCart(shop)).body.data!
    expect(cart.promotions.codes.map((c) => c.code)).toEqual([guestCode])
    const merged = linesSubtotal(cart)
    expect(merged).toBeGreaterThan(linesSubtotal(guest))
    expect(cart.totals.discountTotalMinor).toBe(Math.floor((merged * 2500) / 10_000))
  })

  it('AC-14: a guest cart with a code and no customer cart keeps the code and its discount through sign-in', async () => {
    const code = await percent(1000)
    const { email } = await customer()
    const seeded = await seedVariant(k, 20, { priceMinor: 2400 })
    const shop = await freshShop()
    await addLine(shop, seeded, 2)
    const before = (await putCode(shop, code)).body.data!
    expect(before.totals.discountTotalMinor).toBe(480)

    await signInAs(shop, email)

    const cart = (await readCart(shop)).body.data!
    expect(cart.promotions.codes.map((c) => c.code)).toEqual([code])
    expect(cart.totals.discountTotalMinor).toBe(before.totals.discountTotalMinor)
    expect(cart.totals.totalMinor).toBe(before.totals.totalMinor)
  })
})

describe('AC-15: a code discounts one order', () => {
  it('AC-15: DELETE /api/cart leaves no code: the next line added is at full price', async () => {
    const code = uniqueCode('ONCE')
    await seedPromotion(k, { code, kind: 'percent', percentBps: 1000 })
    const seeded = await seedVariant(k, 20, { priceMinor: 1800 })
    const shop = await freshShop()
    await addLine(shop, seeded, 1)
    expect((await putCode(shop, code)).body.data!.totals.discountTotalMinor).toBe(180)

    expect((await shop.call('DELETE', '/api/cart')).status).toBe(200)
    const next = (await addLine(shop, seeded, 1)).body.data!

    expect(next.promotions.codes).toEqual([])
    expect(next.totals.discountTotalMinor).toBe(0)
    expect(next.totals.totalMinor).toBe(next.totals.subtotalMinor)
    expect(next.totals.subtotalMinor).toBe(1800)
  })

  it('AC-15: the cart cleared by a confirmed payment leaves no code: the next line added is at full price', async () => {
    const code = uniqueCode('PAID')
    await seedPromotion(k, { code, kind: 'percent', percentBps: 1000 })
    const seeded = await seedVariant(k, 20, { priceMinor: 2200 })
    const shop = await freshShop()
    await addLine(shop, seeded, 1)
    expect((await putCode(shop, code)).body.data!.totals.discountTotalMinor).toBe(220)

    const paid = await shop.call('POST', '/api/checkout', {
      email: `paid-${randomUUID()}@promo.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)

    const next = (await addLine(shop, seeded, 1)).body.data!

    expect(next.promotions.codes).toEqual([])
    expect(next.totals.discountTotalMinor).toBe(0)
    expect(next.totals.totalMinor).toBe(next.totals.subtotalMinor)
  })
})

describe('AC-27: the cart event carries the settled total', () => {
  it('AC-27: cart.updated publishes the settled total as totalMinor, which is the total the shopper sees and below the subtotal', async () => {
    const code = uniqueCode('EVENT')
    await seedPromotion(k, { code, kind: 'percent', percentBps: 1000 })
    const seeded = await seedVariant(k, 20, { priceMinor: 3000 })
    const shop = await freshShop()
    await addLine(shop, seeded, 1)
    await putCode(shop, code)

    const res = await shop.call<PricedCart>('PATCH', `/api/cart/items/${seeded.variantId}`, {
      qty: 2,
    })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const cart = res.body.data!
    const published = (await eventRows(raw, 'type = ?', [EVT_CART_UPDATED]))
      .map((e) => (e.envelope as { payload: { cartId: string; totalMinor: number } }).payload)
      .filter((p) => p.cartId === cart.token)
      .at(-1)!
    expect(published.totalMinor).toBe(cart.totals.totalMinor)
    expect(published.totalMinor).toBeLessThan(cart.subtotalMinor)
  })
})
