import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'
import { stubPaymentWebhook } from '../support/proof-kit.js'
import {
  deliver,
  deliverCapture,
  failedFor,
  historyNotes,
  orderStatus,
  paidFor,
  processedCount,
} from '../support/webhooks.js'

// P1-05 AC-4 to AC-7 on SQLite, through the served kernel's real route on the stub payments adapter: every captured
// payment ends in exactly one recorded outcome, the dedupe record exists iff the work committed, and a payment.failed
// names its order. Kills: a dedupe written before the work (AC-4), an in-memory dedupe that forgets on restart
// (AC-5), `finalize_failed` → 5xx and rollback for a confirmed, cancelled or unknown order (AC-6), and
// `orderId: ''` on payment.failed (AC-7).

describe('webhook outcomes', () => {
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

  it('AC-4: a commitReservation that throws once gives the first delivery 5xx and no processed record; the same event id again answers 200 finalized: true, the order is confirmed and there is one order.paid', async () => {
    const seeded = await seedVariant(k, 3)
    const started = await checkoutOf(k, seeded, 1)
    const eventId = `evt_${randomUUID()}`
    const inventory = k.services.inventory
    const original = inventory.commitReservation
    let calls = 0
    inventory.commitReservation = async (...args) => {
      calls += 1
      if (calls === 1) throw new Error('inventory unavailable')
      return original.apply(inventory, args)
    }
    try {
      const first = await deliverCapture(served.baseUrl, started, { eventId })
      expect(first.status).toBeGreaterThanOrEqual(500)
      expect(calls).toBe(1)
      expect(await processedCount(raw, eventId)).toBe(0)
      expect(await orderStatus(raw, started.orderId)).toBe('pending')
      expect(await paidFor(raw, started.orderId)).toEqual([])

      const retry = await deliverCapture(served.baseUrl, started, { eventId })
      expect(retry.status).toBe(200)
      expect(retry.data?.finalized).toBe(true)
    } finally {
      inventory.commitReservation = original
    }
    expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
    expect(await paidFor(raw, started.orderId)).toHaveLength(1)
    expect(await processedCount(raw, eventId)).toBe(1)
  })

  it('AC-5: the same event id delivered twice with a restart in between, on one database, confirms once: the second answer is 200 deduped and there is one order.paid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p1-05-restart-'))
    const sqlitePath = join(dir, 'store.sqlite')
    const eventId = `evt_${randomUUID()}`
    try {
      const first = await serveKernel(await createKernel({ dialect: 'sqlite', sqlitePath }))
      let started: Awaited<ReturnType<typeof checkoutOf>>
      try {
        const seeded = await seedVariant(first.kernel, 3)
        started = await checkoutOf(first.kernel, seeded, 1)
        const answer = await deliverCapture(first.baseUrl, started, { eventId })
        expect(answer.status).toBe(200)
        expect(answer.data?.finalized).toBe(true)
      } finally {
        await first.stop()
      }

      const second = await serveKernel(await createKernel({ dialect: 'sqlite', sqlitePath }))
      try {
        const again = await deliverCapture(second.baseUrl, started, { eventId })
        expect(again.status).toBe(200)
        expect(again.data?.deduped).toBe(true)
        const restarted = openRaw('sqlite', sqlitePath)
        try {
          expect(await paidFor(restarted, started.orderId)).toHaveLength(1)
          expect(await orderStatus(restarted, started.orderId)).toBe('confirmed')
        } finally {
          await restarted.close()
        }
      } finally {
        await second.stop()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('AC-6a: a second event id for the same captured intent gets 200 with no second order.paid, and stock is committed once', async () => {
    const qty = 2
    const seeded = await seedVariant(k, 5)
    const started = await checkoutOf(k, seeded, qty)
    const commitsBefore = await raw.count(
      'stock_adjustments',
      "variant_id = ? AND reason = 'reservation-commit'",
      [seeded.variantId],
    )

    const first = await deliverCapture(served.baseUrl, started)
    expect(first.status).toBe(200)
    expect(first.data?.finalized).toBe(true)

    const second = await deliverCapture(served.baseUrl, started)
    expect(second.status).toBe(200)
    expect(second.data?.finalized).toBe(true)
    expect(second.data?.orderNumber).toBe(started.orderNumber)

    expect(await paidFor(raw, started.orderId)).toHaveLength(1)
    expect(
      (await raw.count('stock_adjustments', "variant_id = ? AND reason = 'reservation-commit'", [
        seeded.variantId,
      ])) - commitsBefore,
    ).toBe(1)
    expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock - qty)
  })

  // P1-12 AC-12 (decision 11): the capture for a cancelled order is refunded and recorded as order_cancelled_refunded.
  it('AC-6b: a captured event for a cancelled order gets 200 finalized: false, reason order_cancelled_refunded, one payment.failed with the order id, a history note, the order stays cancelled, and a redelivery is deduped', async () => {
    const seeded = await seedVariant(k, 3)
    const started = await checkoutOf(k, seeded, 1)
    await k.services.checkout.cancel(started.orderId, 'customer changed their mind')
    expect(await orderStatus(raw, started.orderId)).toBe('cancelled')
    const eventId = `evt_${randomUUID()}`

    const answer = await deliverCapture(served.baseUrl, started, { eventId })

    expect(answer.status).toBe(200)
    expect(answer.data?.finalized).toBe(false)
    expect(answer.data?.reason).toBe('order_cancelled_refunded')
    const failed = await failedFor(raw, { orderId: started.orderId })
    expect(failed).toHaveLength(1)
    expect(failed[0]!).toMatchObject({
      paymentId: started.paymentIntent.id,
      reason: 'order_cancelled_refunded',
    })
    expect(
      (await historyNotes(raw, started.orderId)).some((n) =>
        n.includes('order_cancelled_refunded'),
      ),
    ).toBe(true)
    expect(await orderStatus(raw, started.orderId)).toBe('cancelled')
    expect(await paidFor(raw, started.orderId)).toEqual([])
    // Stock the cancel gave back stays back: the outcome took nothing.
    expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock)
    expect(await processedCount(raw, eventId)).toBe(1)

    const again = await deliverCapture(served.baseUrl, started, { eventId })
    expect(again.status).toBe(200)
    expect(again.data?.deduped).toBe(true)
  })

  it("AC-6c: a captured event for an unknown intent gets 200 with reason no_order and a payment.failed with orderId ''", async () => {
    const intentId = `pi_unknown_${randomUUID().replace(/-/g, '')}`
    const answer = await deliver(
      served.baseUrl,
      stubPaymentWebhook({ paymentIntentId: intentId, amountMinor: 1000, currency: 'GBP' }),
    )

    expect(answer.status).toBe(200)
    expect(answer.data?.finalized).toBe(false)
    expect(answer.data?.reason).toBe('no_order')
    const failed = await failedFor(raw, { paymentId: intentId })
    expect(failed).toHaveLength(1)
    expect(failed[0]!.orderId).toBe('')
    expect(failed[0]!.reason).toBe('no_order')
  })

  it('AC-6d: a capture without a currency gets 200 with reason malformed_capture, not ignored, and the order stays pending', async () => {
    const seeded = await seedVariant(k, 3)
    const started = await checkoutOf(k, seeded, 1)
    const request = stubPaymentWebhook({
      paymentIntentId: started.paymentIntent.id,
      amountMinor: started.totalMinor,
      currency: 'GBP',
    })
    const body = JSON.parse(request.body) as Record<string, unknown>
    delete body.currency

    const answer = await deliver(served.baseUrl, { ...request, body: JSON.stringify(body) })

    expect(answer.status).toBe(200)
    expect(answer.data?.finalized).toBe(false)
    expect(answer.data?.reason).toBe('malformed_capture')
    expect(answer.data?.ignored).toBeUndefined()
    expect(await orderStatus(raw, started.orderId)).toBe('pending')
    expect(await paidFor(raw, started.orderId)).toEqual([])
  })

  it("AC-7: a payment.failed webhook for an intent with an order publishes payment.failed with that order's id", async () => {
    const seeded = await seedVariant(k, 3)
    const started = await checkoutOf(k, seeded, 1)

    const answer = await deliver(
      served.baseUrl,
      stubPaymentWebhook({
        paymentIntentId: started.paymentIntent.id,
        amountMinor: started.totalMinor,
        currency: started.currency,
        kind: 'payment.failed',
      }),
    )

    expect(answer.status).toBe(200)
    const failed = await failedFor(raw, { paymentId: started.paymentIntent.id })
    expect(failed).toHaveLength(1)
    expect(failed[0]!.orderId).toBe(started.orderId)
    expect(await orderStatus(raw, started.orderId)).toBe('pending')
  })
})
