import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OrderStatus, PaymentsAdapter } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { adminClient, storedMoney, type AdminClient } from '../money.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import { deliverCapture, type WebhookAnswer } from '../webhooks.js'

// On one dialect: an admin cancel of a pending (+stub-pending) order, and a confirm of the same order (the provider's
// capture through finalize, or the admin's mark-paid) let in between the cancel's read and its write. The
// interleaving is injected: the cancel's status write (`OrderRepository.setStatus`, or `setStatusIf` to cancelled) is
// held until the confirm has either answered (it committed: nothing serialised it behind the cancel) or is parked
// behind it (Postgres: a backend of this database waits on a lock; SQLite: the confirm has reached the kernel and
// takes its turn on the store's queue). A confirm must never be overwritten to `cancelled` with its money captured.
// The reverse interleaving holds the confirm's write to `confirmed` while the cancel is sent. In both, the variant's
// stock, the reservations it holds and the qty committed from it add up to what was seeded.
// Run on Postgres only: SQLite's single writer queue serialises the cancel and the confirm, so the race cannot happen.

const PARKED_DEADLINE_MS = 15_000
const POLL_MS = 5

type Confirm = 'finalize' | 'mark-paid'

interface Line {
  qty: number
  /** Stock beyond the line's qty. */
  spare: number
}

interface ConfirmAnswer {
  status: number
  body: unknown
}

export function cancelConfirmRaceSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
): void {
  describe(`a cancel racing a confirm (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminClient
    let payments: PaymentsAdapter

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      admin = await adminClient(k, served.baseUrl)
      payments = k.app.adapters.payments
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    /** Backends of this database waiting on a lock another transaction holds. */
    async function lockWaiters(): Promise<number> {
      const row = await raw.one<{ n: number | string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )
      return Number(row.n)
    }

    async function someoneWaitsOnALock(): Promise<boolean> {
      return (await lockWaiters()) > 0
    }

    type Placed = Awaited<ReturnType<typeof checkoutOf>>

    function sendConfirm(confirmWith: Confirm, order: Placed): Promise<ConfirmAnswer> {
      return confirmWith === 'finalize'
        ? deliverCapture(served.baseUrl, order).then((a: WebhookAnswer) => ({
            status: a.status,
            body: a.data ?? a.error,
          }))
        : admin
            .call<{ status: string }>('POST', `/api/admin/orders/${order.orderId}/mark-paid`, {})
            .then((r) => ({ status: r.status, body: r.body.error ?? r.body.data?.status }))
    }

    function sendCancel(order: Placed) {
      return admin.call('POST', `/api/admin/orders/${order.orderId}/cancel`, {
        reason: 'racing a confirm',
      })
    }

    async function place(line: Line) {
      const seeded = await seedVariant(k, line.qty + line.spare, { priceMinor: 2_150 })
      const order = await checkoutOf(k, seeded, line.qty)
      expect(order.orderStatus).toBe('pending')
      return { seeded, order }
    }

    async function race(confirmWith: Confirm, line: Line = { qty: 1, spare: 2 }) {
      const { seeded, order } = await place(line)

      let entered = false
      let confirmAnswer: ConfirmAnswer | undefined
      let confirming: Promise<void> | undefined

      // The confirm's first step inside the kernel, for SQLite's "parked on the queue".
      const parse = payments.parseWebhook
      const markPaid = k.services.checkout.markPaid
      payments.parseWebhook = async (...args) => {
        entered = true
        return parse.apply(payments, args)
      }
      k.services.checkout.markPaid = async (...args) => {
        entered = true
        return markPaid.apply(k.services.checkout, args)
      }

      async function untilConfirmCommittedOrParked(): Promise<void> {
        const deadline = Date.now() + PARKED_DEADLINE_MS
        for (;;) {
          if (confirmAnswer !== undefined) return
          if (dialect === 'sqlite' ? entered : await someoneWaitsOnALock()) return
          if (Date.now() > deadline) {
            throw new Error(`the ${confirmWith} neither answered nor parked behind the cancel`)
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        }
      }

      /** The cancel's write to `cancelled`, held until the confirm has committed or is parked behind the cancel. */
      const hold = async () => {
        if (confirming !== undefined) return
        confirming = sendConfirm(confirmWith, order).then((answer) => {
          confirmAnswer = answer
        })
        await untilConfirmCommittedOrParked()
      }
      const setStatus = k.repos.order.setStatus
      const setStatusIf = k.repos.order.setStatusIf
      k.repos.order.setStatus = async (tx, id, status, at) => {
        if (id === order.orderId && status === 'cancelled') await hold()
        return setStatus.call(k.repos.order, tx, id, status, at)
      }
      k.repos.order.setStatusIf = async (tx, id, from, status, at) => {
        if (id === order.orderId && status === 'cancelled') await hold()
        return setStatusIf.call(k.repos.order, tx, id, from, status, at)
      }

      let cancel: Awaited<ReturnType<AdminClient['call']>>
      try {
        cancel = await sendCancel(order)
        await confirming
      } finally {
        k.repos.order.setStatus = setStatus
        k.repos.order.setStatusIf = setStatusIf
        payments.parseWebhook = parse
        k.services.checkout.markPaid = markPaid
      }
      return {
        seeded,
        order,
        cancel,
        confirm: confirmAnswer!,
        interleaved: confirming !== undefined,
      }
    }

    /**
     * Holds the first status write of `orderId` to `toStatus` inside its transaction, after the command's read, until
     * `releaseWhenOvertaken`: so a second command on the same order always overlaps it. The write is the repository's
     * `setStatus` or `setStatusIf`.
     */
    function holdFirstWrite(orderId: string, toStatus: OrderStatus) {
      const repo = k.repos.order
      const { setStatus, setStatusIf } = repo
      let held = false
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const hold = async (id: string, status: OrderStatus) => {
        if (held || id !== orderId || status !== toStatus) return
        held = true
        await gate
      }
      repo.setStatus = async (...args: Parameters<typeof setStatus>) => {
        await hold(args[1], args[2])
        return setStatus.apply(repo, args)
      }
      repo.setStatusIf = async (...args: Parameters<typeof setStatusIf>) => {
        await hold(args[1], args[3])
        return setStatusIf.apply(repo, args)
      }
      return {
        isHeld: () => held,
        /** Lets the held write go once another command waits on a lock, or nothing else is left to run. */
        async releaseWhenOvertaken(nothingElseLeft: () => boolean) {
          await vi.waitFor(
            async () => {
              expect(held, 'no write was held').toBe(true)
              const overtaken = nothingElseLeft() || (await lockWaiters()) > 0
              expect(overtaken, 'nothing overlapped the held write').toBe(true)
            },
            { timeout: PARKED_DEADLINE_MS, interval: 20 },
          )
          release()
        },
        restore() {
          repo.setStatus = setStatus
          repo.setStatusIf = setStatusIf
          release()
        },
      }
    }

    /** The reverse: the confirm's write to `confirmed` held while the cancel is sent. */
    async function raceConfirmHeld(confirmWith: Confirm, line: Line) {
      const { seeded, order } = await place(line)
      const held = holdFirstWrite(order.orderId, 'confirmed')
      let cancel: Awaited<ReturnType<AdminClient['call']>> | undefined
      try {
        const confirming = sendConfirm(confirmWith, order)
        await vi.waitFor(() => expect(held.isHeld(), 'the confirm reached its write').toBe(true), {
          timeout: PARKED_DEADLINE_MS,
          interval: POLL_MS,
        })
        const cancelling = sendCancel(order).then((answer) => {
          cancel = answer
        })
        await held.releaseWhenOvertaken(() => cancel !== undefined)
        const [confirm] = await Promise.all([confirming, cancelling])
        return { seeded, order, cancel: cancel!, confirm }
      } finally {
        held.restore()
      }
    }

    /** What the variant holds as a second connection reads it: on the shelf, held for orders, and committed to them. */
    async function ledger(variantId: string) {
      const held = await raw.one<{ n: number | string | null }>(
        'SELECT COALESCE(SUM(qty), 0) AS n FROM inventory_reservations WHERE variant_id = ?',
        [variantId],
      )
      const committed = await raw.one<{ n: number | string | null }>(
        "SELECT COALESCE(SUM(-adjustment), 0) AS n FROM stock_adjustments WHERE variant_id = ? AND reason = 'reservation-commit'",
        [variantId],
      )
      return {
        stock: await stockOf(raw, variantId),
        held: Number(held.n),
        committed: Number(committed.n),
      }
    }

    for (const confirmWith of ['finalize', 'mark-paid'] as const) {
      it(`B2: a ${confirmWith} let in between an admin cancel's read and its write never leaves the order cancelled holding money: either the cancel answers 409 order.paid and the order stays confirmed with the capture, or the cancel lands first and the ${confirmWith} finds the order cancelled (captured = refunded) (${dialect})`, async () => {
        const { order, cancel, confirm, interleaved } = await race(confirmWith)

        expect(interleaved).toBe(true)
        const stored = await storedMoney(raw, order.orderId)
        const detail = JSON.stringify({ cancel: cancel.status, confirm, stored })
        // The money the merchant holds on a cancelled order is zero; a confirm the cancel overwrote leaves it at the total.
        if (stored.status === 'cancelled') {
          expect(stored.refundedMinor, detail).toBe(stored.capturedMinor)
          expect(cancel.status, detail).toBe(200)
        } else {
          expect(cancel.status, detail).toBe(409)
          expect(cancel.body.error?.code, detail).toBe('order.paid')
          expect(stored.status, detail).toBe('confirmed')
          expect(stored.capturedMinor, detail).toBe(stored.totalMinor)
        }
        if (confirmWith === 'mark-paid' && stored.status === 'cancelled') {
          // A manual capture that lost to the cancel records nothing.
          expect(confirm.status, detail).toBe(409)
          expect(stored.capturedMinor, detail).toBe(0)
        }
      }, 60_000)
    }

    const interleavings = [
      { name: "the cancel's write held while the", run: race },
      { name: "the confirm's write held while the cancel races its", run: raceConfirmHeld },
    ] as const

    for (const confirmWith of ['finalize', 'mark-paid'] as const) {
      for (const interleaving of interleavings) {
        it(`AC-2: property: with ${interleaving.name} ${confirmWith}, the cancel answers 200 or 409 order.paid, the ${confirmWith} never a 5xx, and stock + held + committed equals the seeded stock: committed and not released when the ${confirmWith} wins, all back on the shelf and a late capture refunded when the cancel wins (${dialect})`, async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.integer({ min: 1, max: 3 }),
              fc.integer({ min: 0, max: 2 }),
              async (qty, spare) => {
                const { seeded, order, cancel, confirm } = await interleaving.run(confirmWith, {
                  qty,
                  spare,
                })
                const stored = await storedMoney(raw, order.orderId)
                const after = await ledger(seeded.variantId)
                const detail = JSON.stringify({
                  cancel: [cancel.status, cancel.body],
                  confirm,
                  stored,
                  after,
                  qty,
                })

                expect(after.stock + after.held + after.committed, detail).toBe(seeded.initialStock)
                if (stored.status === 'confirmed') {
                  expect([cancel.status, cancel.body.error?.code], detail).toEqual([
                    409,
                    'order.paid',
                  ])
                  expect(confirm.status, detail).toBe(200)
                  expect(after, detail).toEqual({
                    stock: seeded.initialStock - qty,
                    held: 0,
                    committed: qty,
                  })
                  expect(stored.capturedMinor, detail).toBe(stored.totalMinor)
                } else {
                  expect(stored.status, detail).toBe('cancelled')
                  expect(cancel.status, detail).toBe(200)
                  // A mark-paid that lost to the cancel is refused as B2 has it; a capture is answered and refunded.
                  expect(confirm.status, detail).toBe(confirmWith === 'finalize' ? 200 : 409)
                  expect(after, detail).toEqual({
                    stock: seeded.initialStock,
                    held: 0,
                    committed: 0,
                  })
                  expect(stored.refundedMinor, detail).toBe(stored.capturedMinor)
                }
              },
            ),
            { numRuns: 3, endOnFailure: true },
          )
        }, 180_000)
      }
    }
  })
}
