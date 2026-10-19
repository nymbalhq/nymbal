import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PaymentsAdapter } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { adminClient, storedMoney, type AdminClient } from '../money.js'
import { openRaw, type RawReader } from '../raw.js'
import { deliverCapture, type WebhookAnswer } from '../webhooks.js'

// P1-13 diff review B2 on one dialect: an admin cancel of a pending (+stub-pending) order, and a confirm of the same
// order (the provider's capture through finalize, or the admin's mark-paid) let in between the cancel's read and its
// write. The interleaving is injected: the cancel's status write (`OrderRepository.setStatus`, or `setStatusIf` to
// cancelled) is held until the confirm has either answered (it committed: nothing serialised it behind the cancel) or
// is parked behind it (Postgres: a backend of this database waits on a lock; SQLite: the confirm has reached the kernel
// and takes its turn on the store's queue). Kills: cancel's `order.paid` guard read without the row lock and an
// unconditional status write, so a confirm committed in between is overwritten to `cancelled` with its money captured.
// Run on Postgres only: SQLite's single writer queue serialises the cancel and the confirm, so the race cannot happen.

const PARKED_DEADLINE_MS = 15_000
const POLL_MS = 5

type Confirm = 'finalize' | 'mark-paid'

export function cancelConfirmRaceSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
): void {
  describe(`P1-13 B2: a cancel racing a confirm (${dialect})`, () => {
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

    /** A backend of this database is waiting on a lock another transaction holds. */
    async function someoneWaitsOnALock(): Promise<boolean> {
      const row = await raw.one<{ n: number | string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )
      return Number(row.n) > 0
    }

    async function race(confirmWith: Confirm) {
      const order = await checkoutOf(k, await seedVariant(k, 3, { priceMinor: 2_150 }), 1)
      expect(order.orderStatus).toBe('pending')

      let entered = false
      let confirmAnswer: { status: number; body: unknown } | undefined
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

      const sendConfirm = (): Promise<void> =>
        (confirmWith === 'finalize'
          ? deliverCapture(served.baseUrl, order).then((a: WebhookAnswer) => ({
              status: a.status,
              body: a.data ?? a.error,
            }))
          : admin
              .call<{ status: string }>('POST', `/api/admin/orders/${order.orderId}/mark-paid`, {})
              .then((r) => ({ status: r.status, body: r.body.error ?? r.body.data?.status }))
        ).then((answer) => {
          confirmAnswer = answer
        })

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
        confirming = sendConfirm()
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
        cancel = await admin.call('POST', `/api/admin/orders/${order.orderId}/cancel`, {
          reason: 'racing a confirm',
        })
        await confirming
      } finally {
        k.repos.order.setStatus = setStatus
        k.repos.order.setStatusIf = setStatusIf
        payments.parseWebhook = parse
        k.services.checkout.markPaid = markPaid
      }
      return { order, cancel, confirm: confirmAnswer!, interleaved: confirming !== undefined }
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
  })
}
