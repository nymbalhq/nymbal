import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import fc from 'fast-check'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart, PaymentsAdapter } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'

// AC-3 on one dialect, over HTTP on a kernel from `src/`: one cart makes one order. Two submits racing in the window
// before the payment intent is set, two racing after it, a resubmit after the first answer, and a changed cart each
// leave one order for the cart and one set of reservations. The property drives random submits (one at a time and in
// bursts) and cart changes against one cart: pending orders per cart ≤ 1 and the stock plus what is reserved is the
// stock at the start. The partial unique index is checked with the lock bypassed: a second pending row for the cart
// is refused, a cancelled one is not.

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  paymentIntent: { id: string }
  orderStatus: string
  payment: { status: string; reason?: string }
}

interface ErrorAnswer {
  code: string
  message: string
  context?: { orderNumber?: string }
}

type Shop = Awaited<ReturnType<typeof primedShopper>>

const pending = (tag: string) => `ac3-${tag}-${randomUUID()}+stub-pending@checkout.test`
const paying = (tag: string) => `ac3-${tag}-${randomUUID()}@checkout.test`

export function singleOrderSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`AC-3: one order per cart (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let payments: PaymentsAdapter

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      payments = k.app.adapters.payments
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    async function shopWith(lines: Array<{ seeded: Seeded; qty: number }>) {
      const shop = await primedShopper(served.baseUrl)
      expect((await shop.call<Cart>('GET', '/api/cart')).status).toBe(200)
      for (const { seeded, qty } of lines) {
        const added = await shop.call<Cart>('POST', '/api/cart/items', {
          variantId: seeded.variantId,
          qty,
        })
        expect(added.status, JSON.stringify(added.body)).toBe(200)
      }
      const token = shop.jar.get('nymbal.cart')
      if (token === undefined) throw new Error('the store set no nymbal.cart cookie')
      return { shop, token }
    }

    function submit(shop: Shop, email: string) {
      return shop.call<CheckoutAnswer>('POST', '/api/checkout', {
        email,
        billingAddress: address,
        shippingAddress: address,
      })
    }

    /** Every order checkout made from the cart, read from its metadata (present before and after the column). */
    async function ordersOf(token: string) {
      const rows = await raw.rows<{
        id: string
        status: string
        payment_intent_id: string | null
        metadata: string | { cartToken?: string }
      }>('SELECT id, status, payment_intent_id, metadata FROM orders')
      return rows.filter((r) => {
        const metadata = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata
        return (metadata as { cartToken?: string }).cartToken === token
      })
    }

    async function reservedQty(variantId: string): Promise<number> {
      const rows = await raw.rows<{ qty: number }>(
        'SELECT qty FROM inventory_reservations WHERE variant_id = ?',
        [variantId],
      )
      return rows.reduce((sum, r) => sum + Number(r.qty), 0)
    }

    /** Counts the adapter's createPaymentIntent calls while `run` runs; the checkout service calls it at call time. */
    async function countingIntents<T>(run: (calls: () => number) => Promise<T>): Promise<T> {
      const original = payments.createPaymentIntent
      let calls = 0
      payments.createPaymentIntent = (params) => {
        calls += 1
        return original.call(payments, params)
      }
      try {
        return await run(() => calls)
      } finally {
        payments.createPaymentIntent = original
      }
    }

    // Kills: no guard between the order's commit and its intent: a second submit in that window makes a second order
    // with its own reservations and a second intent.
    it(`AC-3: a second POST /api/checkout on the cart while the first is creating its payment intent answers 409 checkout.in_progress or the same order; one order, one intent, one decrement (${dialect})`, async () => {
      const qty = 2
      const seeded = await seedVariant(k, 6)
      const { shop, token } = await shopWith([{ seeded, qty }])
      const original = payments.createPaymentIntent
      let entered!: () => void
      const inside = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let intents = 0
      payments.createPaymentIntent = async (params) => {
        intents += 1
        if (intents === 1) {
          entered()
          await gate
        }
        return original.call(payments, params)
      }
      let first: Awaited<ReturnType<typeof submit>>
      let second: Awaited<ReturnType<typeof submit>>
      try {
        const firstCall = submit(shop, paying('window'))
        await inside
        second = await submit(shop, paying('window-2'))
        release()
        first = await firstCall
      } finally {
        release()
        payments.createPaymentIntent = original
      }

      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const firstOrder = first.body.data!.orderId
      const secondOutcome =
        second.status === 200
          ? { status: 200, sameOrder: second.body.data?.orderId === firstOrder }
          : { status: second.status, code: (second.body.error as ErrorAnswer | undefined)?.code }
      expect([
        { status: 200, sameOrder: true },
        { status: 409, code: 'checkout.in_progress' },
      ]).toContainEqual(secondOutcome)
      expect((await ordersOf(token)).map((o) => o.id)).toEqual([firstOrder])
      expect(intents).toBe(1)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
    })

    // Kills: a resubmit (double click, Back and submit) of a cart whose pending order already holds an intent makes a
    // second order, a second intent or a second reservation.
    it(`AC-3: with +stub-pending, a resubmit after the first answer and two concurrent resubmits each return the same order and intent; one order, one intent, reservations = qty (${dialect})`, async () => {
      const qty = 3
      const seeded = await seedVariant(k, 8)
      const { shop, token } = await shopWith([{ seeded, qty }])

      await countingIntents(async (intents) => {
        const first = await submit(shop, pending('resubmit'))
        expect(first.status, JSON.stringify(first.body)).toBe(200)
        const order = first.body.data!

        const again = await submit(shop, pending('resubmit'))
        const burst = await Promise.all([
          submit(shop, pending('resubmit')),
          submit(shop, pending('resubmit')),
        ])

        const outcome = (r: Awaited<ReturnType<typeof submit>>) =>
          r.status === 200
            ? {
                status: 200,
                same: r.body.data?.orderId === order.orderId,
                sameIntent: r.body.data?.paymentIntent.id === order.paymentIntent.id,
              }
            : { status: r.status, code: (r.body.error as ErrorAnswer | undefined)?.code }
        expect(outcome(again)).toEqual({ status: 200, same: true, sameIntent: true })
        for (const r of burst) {
          expect([
            { status: 200, same: true, sameIntent: true },
            { status: 409, code: 'checkout.in_progress' },
          ]).toContainEqual(outcome(r))
        }
        const orders = await ordersOf(token)
        expect(orders.map((o) => [o.id, o.status, o.payment_intent_id])).toEqual([
          [order.orderId, 'pending', order.paymentIntent.id],
        ])
        expect(intents()).toBe(1)
        expect(await reservedQty(seeded.variantId)).toBe(qty)
        expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
        expect(order.payment?.status).toBe('requires_action')
      })
    })

    // Kills: the cart left full after the stub paid, so a second submit makes a second paid order; or a 409 that does
    // not name the order the cart became, so the storefront cannot take the shopper to it.
    it(`AC-3: after a paid checkout, a resubmit from the same cart answers 409 checkout.cart_empty naming the converted order; no second order (${dialect})`, async () => {
      const qty = 1
      const seeded = await seedVariant(k, 4)
      const { shop, token } = await shopWith([{ seeded, qty }])

      const first = await submit(shop, paying('converted'))
      const again = await submit(shop, paying('converted'))

      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect(again.status, JSON.stringify(again.body)).toBe(409)
      const error = again.body.error as ErrorAnswer | undefined
      expect(error?.code).toBe('checkout.cart_empty')
      expect(error?.context?.orderNumber).toBe(first.body.data!.orderNumber)
      expect((await ordersOf(token)).map((o) => o.id)).toEqual([first.body.data!.orderId])
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
    })

    // Kills: a changed cart that adds a second pending order beside the first (two sets of reservations), or that
    // keeps the first order's reservations after replacing it.
    it(`AC-3: a changed cart supersedes its pending order: the old order is cancelled with its reservations released, the new one holds the new lines, one pending order for the cart (${dialect})`, async () => {
      const a = await seedVariant(k, 6)
      const b = await seedVariant(k, 6)
      const { shop, token } = await shopWith([{ seeded: a, qty: 1 }])
      const first = await submit(shop, pending('supersede'))
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const added = await shop.call<Cart>('POST', '/api/cart/items', {
        variantId: b.variantId,
        qty: 2,
      })
      expect(added.status, JSON.stringify(added.body)).toBe(200)

      const second = await submit(shop, pending('supersede'))

      expect(second.status, JSON.stringify(second.body)).toBe(200)
      expect(second.body.data!.orderId).not.toBe(first.body.data!.orderId)
      const orders = await ordersOf(token)
      expect(Object.fromEntries(orders.map((o) => [o.id, o.status]))).toEqual({
        [first.body.data!.orderId]: 'cancelled',
        [second.body.data!.orderId]: 'pending',
      })
      expect(await reservedQty(a.variantId)).toBe(1)
      expect(await reservedQty(b.variantId)).toBe(2)
      expect(await stockOf(raw, a.variantId)).toBe(a.initialStock - 1)
      expect(await stockOf(raw, b.variantId)).toBe(b.initialStock - 2)
    })

    // Kills: any path, sequential or concurrent, that leaves two pending orders on one cart or leaks a reservation.
    it(`AC-3: over random submits, bursts and cart changes on one cart (+stub-pending), pending orders for the cart ≤ 1 and stock + reserved = the stock at the start, after every step (${dialect})`, async () => {
      const op = fc.oneof(
        fc.constant({ kind: 'submit' as const }),
        fc.record({ kind: fc.constant('burst' as const), size: fc.integer({ min: 2, max: 4 }) }),
        fc.record({ kind: fc.constant('add' as const), qty: fc.integer({ min: 1, max: 2 }) }),
      )
      await fc.assert(
        fc.asyncProperty(fc.array(op, { minLength: 2, maxLength: 6 }), async (ops) => {
          const initial = 30
          const seeded = await seedVariant(k, initial)
          const { shop, token } = await shopWith([{ seeded, qty: 1 }])
          for (const step of ops) {
            if (step.kind === 'submit') await submit(shop, pending('prop'))
            if (step.kind === 'burst') {
              await Promise.all(
                Array.from({ length: step.size }, () => submit(shop, pending('prop'))),
              )
            }
            if (step.kind === 'add') {
              await shop.call('POST', '/api/cart/items', {
                variantId: seeded.variantId,
                qty: step.qty,
              })
            }
            const open = (await ordersOf(token)).filter((o) => o.status === 'pending')
            const reserved = await reservedQty(seeded.variantId)
            const stock = await stockOf(raw, seeded.variantId)
            expect(open.length, `pending orders after ${step.kind}`).toBeLessThanOrEqual(1)
            expect(stock + reserved, `stock + reserved after ${step.kind}`).toBe(initial)
            expect(reserved).toBeLessThanOrEqual(initial)
          }
        }),
        { numRuns: 10 },
      )
    }, 120_000)

    // Kills: a guard that lives only in the lock, so a writer that bypasses it (the Postgres lock-then-insert race)
    // stores two pending orders for one cart; or a plain unique index that also refuses a cart's cancelled orders.
    it(`AC-3: with the lock bypassed, the database refuses a second pending order for the cart and accepts a cancelled one (${dialect})`, async () => {
      const seeded = await seedVariant(k, 4)
      const { shop } = await shopWith([{ seeded, qty: 1 }])
      const first = await submit(shop, pending('index'))
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const orderId = first.body.data!.orderId

      const pendingCopy = await copyOrder(k, orderId, 'pending')
      const cancelledCopy = await copyOrder(k, orderId, 'cancelled')

      expect(pendingCopy.inserted, 'a second pending row for the cart').toBe(false)
      expect(pendingCopy.error ?? '').toMatch(/unique|UNIQUE|duplicate/)
      expect(cancelledCopy).toEqual({ inserted: true })
    })
  })
}

/**
 * Inserts a copy of order `orderId` with a fresh id, number and sequence and no intent, as a writer that skipped the
 * checkout's lock would: every other column (the cart it came from included) is copied as it is.
 */
async function copyOrder(
  k: Kernel,
  orderId: string,
  status: 'pending' | 'cancelled',
): Promise<{ inserted: boolean; error?: string }> {
  const tag = randomUUID().slice(0, 8)
  const replaced: Record<string, string> = {
    id: '?',
    order_number: '?',
    status: '?',
    sequence: '(SELECT max(sequence) + 1000 FROM orders)',
    payment_intent_id: 'NULL',
  }
  const params = [`copy-${tag}`, `COPY-${tag}`, status, orderId]
  if (k.dialect === 'sqlite') {
    const db = new Database(k.target)
    db.pragma('busy_timeout = 5000')
    try {
      const columns = (
        db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>
      ).map((c) => c.name)
      const select = columns.map((c) => replaced[c] ?? c).join(', ')
      db.prepare(
        `INSERT INTO orders (${columns.join(', ')}) SELECT ${select} FROM orders WHERE id = ?`,
      ).run(...params)
      return { inserted: true }
    } catch (error) {
      return { inserted: false, error: String(error) }
    } finally {
      db.close()
    }
  }
  const pool = new pg.Pool({ connectionString: k.target, max: 1 })
  try {
    const { rows } = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' ORDER BY ordinal_position",
    )
    const columns = rows.map((r) => r.column_name)
    let n = 0
    const select = columns
      .map((c) => replaced[c] ?? c)
      .join(', ')
      .replace(/\?/g, () => `$${(n += 1)}`)
    await pool.query(
      `INSERT INTO orders (${columns.join(', ')}) SELECT ${select} FROM orders WHERE id = $${n + 1}`,
      params,
    )
    return { inserted: true }
  } catch (error) {
    return { inserted: false, error: String(error) }
  } finally {
    await pool.end()
  }
}
