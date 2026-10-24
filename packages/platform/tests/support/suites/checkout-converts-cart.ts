import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CART_CONVERTED, EVT_ORDER_PAID } from '@nymbalhq/types'
import { address, createKernel, seedVariant, type Dialect, type Kernel } from '../kernel.js'
import { eventRows } from '../outbox.js'
import { runUntilKilled } from '../proof-kit.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import { clockAt, lineFor, migrateTarget, openReplica, type Replica } from '../replica.js'

// AC-4 and AC-4b on one dialect: a paid order and its emptied cart commit together. The child process
// (fixtures/checkout-finalize-kill-child.mjs) checks out and finalises on a real store and is SIGKILLed at the first
// bus publish after the finalize transaction commits; a kernel reopened on the database then sees the order confirmed,
// the cart present and empty, and one cart.converted.v1 for the order. AC-4b: a cart that expired before finalize is
// not an error, and the order still confirms with its cart.converted.v1.

export const FINALIZE_KILL_CHILD = fileURLToPath(
  new URL('../../integration/fixtures/checkout-finalize-kill-child.mjs', import.meta.url),
)

/** What the child plants: one variant at this stock, a checkout of this many units at this price. */
export const CHILD = { stock: 3, qty: 2, priceMinor: 1500 }

interface Converted {
  cartId: string
  orderId: string
}

export function checkoutConvertsCartSuite(
  dialect: Dialect,
  /** A fresh, empty database for one test: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`checkout converts the cart (${dialect})`, () => {
    async function convertedFor(raw: RawReader, orderId: string): Promise<Converted[]> {
      const rows = await eventRows(raw, 'type = ?', [EVT_CART_CONVERTED])
      return rows
        .map((row) => row.envelope.payload as Converted)
        .filter((payload) => payload.orderId === orderId)
    }

    it('AC-4: SIGKILL at the first bus publish after the finalize commit: reopened, the order is confirmed, the cart token reads back with zero items, and events holds exactly one cart.converted.v1 for the order', async () => {
      const db = await fresh()
      const dir = mkdtempSync(join(tmpdir(), 'cart-finalize-kill-'))
      const handoff = join(dir, 'handoff.json')
      const token = randomUUID()
      let kernel: Kernel | undefined
      let raw: RawReader | undefined
      try {
        const run = await runUntilKilled({
          script: FINALIZE_KILL_CHILD,
          args: [dialect, db.target, token, handoff],
          point: { beforePublish: '*', nth: 1 },
          timeoutMs: 60_000,
        })
        expect(
          { killed: run.killed, signal: run.signal, timedOut: run.timedOut },
          `${run.stdout}\n${run.stderr}`,
        ).toEqual({ killed: true, signal: 'SIGKILL', timedOut: false })
        const { orderId } = JSON.parse(readFileSync(handoff, 'utf8')) as { orderId: string }

        kernel = await createKernel(
          dialect === 'sqlite'
            ? { dialect, sqlitePath: db.target }
            : { dialect, postgresUrl: db.target },
        )
        raw = openRaw(dialect, db.target)

        const order = await kernel.services.order.getById(orderId)
        expect(order.status).toBe('confirmed')

        const cart = await kernel.services.cart.get(token)
        expect(cart, 'the cart token no longer reads back').not.toBeNull()
        expect(cart!.items).toEqual([])
        expect(cart!.subtotalMinor).toBe(0)

        const converted = await convertedFor(raw, orderId)
        expect(converted.map((c) => c.cartId)).toEqual([token])
      } finally {
        await raw?.close()
        await kernel?.close()
        rmSync(dir, { recursive: true, force: true })
        await db.drop()
      }
    }, 90_000)

    describe('AC-4b: a cart expired before finalize', () => {
      let db: { target: string; drop(): Promise<void> }
      let raw: RawReader
      let replica: Replica
      const ttlSeconds = 3600
      const clock = clockAt()

      beforeAll(async () => {
        db = await fresh()
        await migrateTarget(dialect, db.target)
        raw = openRaw(dialect, db.target)
        replica = await openReplica(dialect, db.target, { clock, ttlSeconds })
      }, 60_000)

      afterAll(async () => {
        await replica?.close()
        await raw?.close()
        await db?.drop()
      })

      it('AC-4b: finalize still confirms the order, commits the stock, appends order.paid.v1 and exactly one cart.converted.v1 naming the cart token; the cart stays missing', async () => {
        const qty = 2
        const seeded = await seedVariant(replica, 5, { priceMinor: 700 })
        const cart = await replica.services.cart.getOrCreate()
        await replica.services.cart.addItem(cart.token, lineFor(seeded, qty))
        const started = await replica.services.checkout.beginCheckout({
          cartToken: cart.token,
          // `+stub-pending`: the cart expires before the payment, which is the finalize below.
          email: `expired-${randomUUID()}+stub-pending@cart.test`,
          billingAddress: address,
          shippingAddress: address,
        })

        clock.advance(ttlSeconds * 1000 + 1000)
        expect(await replica.services.cart.get(cart.token), 'the cart has expired').toBeNull()

        const result = await replica.services.checkout.finalize(started.paymentIntent.id, {
          amountMinor: started.totalMinor,
          currency: started.currency,
        })
        expect(result.orderNumber).toBe(started.orderNumber)

        const order = await replica.services.order.getById(started.orderId)
        expect(order.status).toBe('confirmed')
        expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
        expect(
          await raw.count('inventory_reservations', 'variant_id = ?', [seeded.variantId]),
        ).toBe(0)

        const paid = (await eventRows(raw, 'type = ?', [EVT_ORDER_PAID])).filter(
          (row) => (row.envelope.payload as { orderId: string }).orderId === started.orderId,
        )
        expect(paid.length).toBe(1)
        expect((await convertedFor(raw, started.orderId)).map((c) => c.cartId)).toEqual([
          cart.token,
        ])
        expect(await replica.services.cart.get(cart.token)).toBeNull()
      })
    })
  })
}
