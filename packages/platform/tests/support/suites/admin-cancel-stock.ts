import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { adminClient, type AdminClient } from '../money.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import { unaudited } from '../write-audit.js'

// On one dialect: an admin cancel (POST /api/admin/orders/:id/cancel) of an order the store placed. A pending order's
// held stock comes back with the cancel, not when the reservation sweeper finds it past its TTL; an order whose stock
// was already committed moves no stock. Committed state is read through a second connection.

interface Line {
  qty: number
  /** Stock beyond the line's qty. */
  spare: number
}

interface CancelAnswer {
  status: string
}

interface HistoryRow {
  to_status: string
  actor: string
  note: string
}

export function adminCancelStockSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: { runs: number },
): void {
  describe(`an admin cancel and the stock its order held (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminClient

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      admin = await adminClient(k, served.baseUrl)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    /** A pending (`+stub-pending`) order of one fresh variant per line, through the services. */
    async function pendingOrder(lines: Line[]) {
      const seeded: Seeded[] = []
      for (const line of lines) seeded.push(await seedVariant(k, line.qty + line.spare))
      const cart = await k.services.cart.getOrCreate()
      for (const [i, s] of seeded.entries()) {
        await k.services.cart.addItem(cart.token, {
          variantId: s.variantId,
          productId: s.productId,
          productName: 'Transactional Widget',
          variantName: 'Default',
          priceMinor: s.priceMinor,
          imageUrl: '',
          qty: lines[i]!.qty,
        })
      }
      const started = await k.services.checkout.beginCheckout({
        cartToken: cart.token,
        email: `buyer-${randomUUID()}+stub-pending@cancel.test`,
        billingAddress: address,
        shippingAddress: address,
      })
      return { started, seeded }
    }

    const stocks = (seeded: Seeded[]) => Promise.all(seeded.map((s) => stockOf(raw, s.variantId)))
    const heldFor = (seeded: Seeded[]) =>
      Promise.all(
        seeded.map((s) => raw.count('inventory_reservations', 'variant_id = ?', [s.variantId])),
      )
    const adjustments = (seeded: Seeded[], reason: string) =>
      Promise.all(
        seeded.map((s) =>
          raw.count('stock_adjustments', 'variant_id = ? AND reason = ?', [s.variantId, reason]),
        ),
      )
    const cancelled = (orderId: string) =>
      raw.rows<HistoryRow>(
        "SELECT to_status, actor, note FROM order_history WHERE order_id = ? AND to_status = 'cancelled'",
        [orderId],
      )
    const cancel = (orderId: string, reason: string) =>
      admin.call<CancelAnswer>('POST', `/api/admin/orders/${orderId}/cancel`, { reason })

    it(`AC-1: property (${opts.runs} carts of 1-4 lines, qty 1-5): an admin cancel of a pending order puts every variant's stock back to its value before checkout at once, leaves no reservation for the order and one reservation-release row per line (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              qty: fc.integer({ min: 1, max: 5 }),
              spare: fc.integer({ min: 0, max: 5 }),
            }),
            { minLength: 1, maxLength: 4 },
          ),
          async (lines) => {
            const { started, seeded } = await pendingOrder(lines)
            const before = seeded.map((s) => s.initialStock)
            expect(started.orderStatus).toBe('pending')
            // The checkout's hold took each line's qty from stock.
            expect(await stocks(seeded)).toEqual(before.map((stock, i) => stock - lines[i]!.qty))

            const answer = await cancel(started.orderId, 'customer changed their mind')

            expect([answer.status, answer.body.data?.status], JSON.stringify(answer.body)).toEqual([
              200,
              'cancelled',
            ])
            expect(await stocks(seeded), 'stock after the cancel').toEqual(before)
            expect(
              await raw.count('inventory_reservations', 'order_ref = ?', [started.orderId]),
              'reservations the order still holds',
            ).toBe(0)
            expect(await heldFor(seeded)).toEqual(seeded.map(() => 0))
            expect(
              await adjustments(seeded, 'reservation-release'),
              'reservation-release rows per line',
            ).toEqual(seeded.map(() => 1))
          },
        ),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 120_000)

    it(`AC-3: an admin cancel records admin:<userId> as the actor with the reason given (${dialect})`, async () => {
      const { started } = await pendingOrder([{ qty: 2, spare: 1 }])
      const reason = `out of stock at the warehouse ${randomUUID().slice(0, 8)}`

      const answer = await cancel(started.orderId, reason)

      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      expect(await cancelled(started.orderId)).toEqual([
        { to_status: 'cancelled', actor: `admin:${admin.userId}`, note: reason },
      ])
    }, 60_000)

    it(`AC-3: an admin cancel of a confirmed, uncaptured order whose stock was already committed moves no stock and releases nothing (${dialect})`, async () => {
      const lines = [
        { qty: 2, spare: 3 },
        { qty: 1, spare: 0 },
      ]
      const { started, seeded } = await pendingOrder(lines)
      // Confirmed with no payment captured, its reservations committed: an imported order not yet paid.
      const order = await k.store.read((tx) => k.repos.order.findById(tx, started.orderId))
      const reservationIds = (order!.metadata as { reservationIds: string[] }).reservationIds
      expect(reservationIds).toHaveLength(lines.length)
      await unaudited(async () => {
        for (const rid of reservationIds)
          await k.services.inventory.commitReservation(rid, 'import')
        await k.store.transaction((tx) =>
          k.repos.order.setStatusIf(tx, started.orderId, 'pending', 'confirmed', new Date()),
        )
      })
      const stockBefore = await stocks(seeded)
      const commitsBefore = await adjustments(seeded, 'reservation-commit')
      const reason = `duplicate import ${randomUUID().slice(0, 8)}`

      const answer = await cancel(started.orderId, reason)

      expect([answer.status, answer.body.data?.status], JSON.stringify(answer.body)).toEqual([
        200,
        'cancelled',
      ])
      expect(await stocks(seeded), 'stock after the cancel').toEqual(stockBefore)
      expect(stockBefore).toEqual(seeded.map((s, i) => s.initialStock - lines[i]!.qty))
      expect(await adjustments(seeded, 'reservation-release')).toEqual(seeded.map(() => 0))
      expect(await adjustments(seeded, 'reservation-commit')).toEqual(commitsBefore)
      expect(await cancelled(started.orderId)).toEqual([
        { to_status: 'cancelled', actor: `admin:${admin.userId}`, note: reason },
      ])
    }, 60_000)
  })
}
