import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORDER_KEY_HEADER, PaymentError, type PaymentsAdapter, type Refund } from '@nymbalhq/types'
import { hashOrderKey, mintOrderKey } from '../../src/order-access-key.js'
import { activityEntries, adminSession, type AdminSession } from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import {
  address,
  cartWith,
  checkoutOf,
  createKernel,
  seedVariant,
  type Kernel,
} from '../support/kernel.js'
import {
  adminClient,
  storedMoney,
  storedRefunds,
  type AdminClient,
  type AdminOrder,
} from '../support/money.js'
import {
  allRefundEvents,
  answerListWith,
  customerSpend,
  deliverRefunded,
  listed,
  paidOrder,
  refundEvents,
  refundHistory,
  refundedDelivery,
  registeredCustomer,
  type ListedRefund,
  type PaidOrder,
} from '../support/provider-refunds.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { captureLogs, type LogCapture } from '../support/settings.js'
import { deliver, deliverCapture, orderStatus, processedCount } from '../support/webhooks.js'
import { unaudited } from '../support/write-audit.js'

// A `payment.refunded` delivery through the real route on a served SQLite kernel: what it answers, what it leaves on the
// order, and what the merchant and the shopper then read.

type RefundImpl = (...args: unknown[]) => Promise<Refund>

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminClient
let session: AdminSession
let payments: PaymentsAdapter
let stubRefund: RefundImpl
let logs: LogCapture

beforeAll(async () => {
  logs = captureLogs()
  k = await createKernel({ dialect: 'sqlite', logger: logs.logger })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminClient(k, served.baseUrl)
  session = await adminSession(k, served.baseUrl)
  payments = k.app.adapters.payments
  stubRefund = payments.refund.bind(payments) as RefundImpl
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

function errorsNaming(from: number, ...ids: string[]): string[] {
  return logs.calls
    .slice(from)
    .filter((call) => call.level === 'error')
    .map((call) => JSON.stringify(call.obj))
    .filter((line) => ids.every((id) => line.includes(id)))
}

/** A checkout left pending, owned by `customerId` when given; `+stub-pending` keeps it unpaid until a capture. */
async function pendingOrder(customerId?: string) {
  const seeded = await seedVariant(k, 3)
  const started = await k.services.checkout.beginCheckout({
    cartToken: await cartWith(k, seeded, 1),
    email: `cancel-${randomUUID()}+stub-pending@money.test`,
    billingAddress: address,
    shippingAddress: address,
    ...(customerId !== undefined && { customerId }),
  })
  return started
}

function cancelled(orderId: string) {
  return k.services.checkout.cancel(orderId, 'customer changed their mind')
}

describe('a refund on a cancelled order', () => {
  // Defect: the cancelled path gets recordSucceeded, or the webhook's pass counts the capture's refund twice.
  it('AC-6: a webhook during a cancelled capture’s provider refund leaves refundedMinor = captured, one payment.refunded.v1, no order.*refunded.v1, no history row, stats untouched and the order cancelled', async () => {
    const customerId = await registeredCustomer(k)
    const started = await pendingOrder(customerId)
    await cancelled(started.orderId)
    const spentBefore = await customerSpend(raw, customerId)

    let webhook: ReturnType<typeof deliver> | undefined
    payments.refund = (async (...args: unknown[]) => {
      const answer = await stubRefund(...args)
      // The provider call sits inside the capture delivery's transaction, so the webhook runs beside it, not before it.
      webhook = deliver(served.baseUrl, refundedDelivery(args[0] as string))
      return answer
    }) as PaymentsAdapter['refund']
    try {
      const capture = await deliverCapture(served.baseUrl, started)
      expect(capture.data?.['reason']).toBe('order_cancelled_refunded')
    } finally {
      payments.refund = stubRefund as PaymentsAdapter['refund']
    }
    const delivered = await webhook!
    expect(delivered.status, JSON.stringify(delivered)).toBe(200)

    const money = await storedMoney(raw, started.orderId)
    expect(money.refundedMinor).toBe(money.capturedMinor)
    expect(money.status).toBe('cancelled')
    expect(await refundEvents(raw, 'payment.refunded.v1', started.orderId)).toHaveLength(1)
    expect(await refundEvents(raw, 'order.refunded.v1', started.orderId)).toHaveLength(0)
    expect(await refundEvents(raw, 'order.partially_refunded.v1', started.orderId)).toHaveLength(0)
    expect(await refundHistory(raw, started.orderId)).toHaveLength(0)
    expect(await customerSpend(raw, customerId)).toBe(spentBefore)
    expect(delivered.data?.['reconciled'], 'the delivery ran the pass').toBe(true)
  })

  // Defect: the checkout path ignores settle's boolean and publishes the event for a row another writer settled.
  it('AC-6: a cancelled capture’s row another writer settled while the provider answered gets no second payment.refunded.v1', async () => {
    const started = await pendingOrder()
    await cancelled(started.orderId)
    payments.refund = (async (...args: unknown[]) => {
      const answer = await stubRefund(...args)
      await unaudited(() =>
        k.store.transaction(async (tx) => {
          const [row] = await k.repos.orderRefund.listByOrder(tx, started.orderId)
          await k.repos.orderRefund.settle(tx, row!.id, {
            status: 'succeeded',
            providerRefundId: answer.refundId,
          })
        }),
      )
      return answer
    }) as PaymentsAdapter['refund']
    try {
      await deliverCapture(served.baseUrl, started)
    } finally {
      payments.refund = stubRefund as PaymentsAdapter['refund']
    }
    expect(await refundEvents(raw, 'payment.refunded.v1', started.orderId)).toHaveLength(0)
  })

  // Defect: a dashboard refund on a cancelled order is given recordSucceeded's effects.
  it('AC-6: a dashboard refund on a cancelled captured order records refundedMinor with one payment.refunded.v1, no order event, no history row and stats untouched', async () => {
    const customerId = await registeredCustomer(k)
    const started = await pendingOrder(customerId)
    await cancelled(started.orderId)
    payments.refund = (async () => {
      throw new PaymentError('refund_rejected', 'provider refused')
    }) as PaymentsAdapter['refund']
    try {
      await deliverCapture(served.baseUrl, started)
    } finally {
      payments.refund = stubRefund as PaymentsAdapter['refund']
    }
    const spentBefore = await customerSpend(raw, customerId)
    const captured = (await storedMoney(raw, started.orderId)).capturedMinor
    const providerId = `re_dash_${randomUUID()}`

    const answer = await deliverRefunded(served.baseUrl, started.paymentIntent.id, {
      refund: { id: providerId, amountMinor: captured },
    })

    expect(answer.status, JSON.stringify(answer)).toBe(200)
    const money = await storedMoney(raw, started.orderId)
    expect(money.refundedMinor).toBe(captured)
    expect(money.status).toBe('cancelled')
    expect(await refundEvents(raw, 'payment.refunded.v1', started.orderId)).toHaveLength(1)
    expect(await refundEvents(raw, 'order.refunded.v1', started.orderId)).toHaveLength(0)
    expect(await refundEvents(raw, 'order.partially_refunded.v1', started.orderId)).toHaveLength(0)
    expect(await refundHistory(raw, started.orderId)).toHaveLength(0)
    expect(await customerSpend(raw, customerId)).toBe(spentBefore)
    const rows = await storedRefunds(raw, started.orderId)
    expect(rows.filter((r) => r.providerRefundId === providerId)).toHaveLength(1)
  })
})

describe('the guards on a payment.refunded delivery', () => {
  // Defect: a shared Stripe account's unrelated refund errors, writes or is looked up.
  it('AC-7: a refund for an intent no order holds answers 200 ignored unknown_order and asks the provider nothing', async () => {
    const listing = answerListWith(payments, () => [])
    try {
      const answer = await deliverRefunded(served.baseUrl, `pi_stub_unknown_${randomUUID()}`, {})
      expect(answer.status).toBe(200)
      expect(answer.data).toEqual({ ignored: true, reason: 'unknown_order' })
      expect(listing.calls()).toBe(0)
    } finally {
      listing.restore()
    }
  })

  it('AC-7: a refund event with no payment intent answers 200 ignored no_payment and is marked delivered', async () => {
    const eventId = `evt_${randomUUID()}`
    const listing = answerListWith(payments, () => [])
    try {
      const answer = await deliverRefunded(served.baseUrl, undefined, { eventId })
      expect(answer.status).toBe(200)
      expect(answer.data).toEqual({ ignored: true, reason: 'no_payment' })
      expect(listing.calls()).toBe(0)
      expect(await processedCount(raw, eventId)).toBe(1)
    } finally {
      listing.restore()
    }
  })

  /** An order the merchant holds the money for, carrying a provider intent: marked paid or imported. */
  async function merchantHeld(method: 'manual' | 'import'): Promise<PaidOrder> {
    if (method === 'manual') {
      const order = await checkoutOf(k, await seedVariant(k, 3), 1)
      await k.services.checkout.markPaid(order.orderId, 'admin:refunds', 'paid by bank transfer')
      return {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        intentId: order.paymentIntent.id,
        totalMinor: order.totalMinor,
        currency: order.currency,
        status: 'confirmed',
      }
    }
    const orderId = uuidv7()
    const orderNumber = `IMP-${randomUUID().slice(0, 8)}`
    const intentId = `pi_stub_imported_${randomUUID()}`
    await k.services.order.importOrder({
      orderId,
      orderNumber,
      status: 'confirmed',
      customerId: null,
      email: `imported-${randomUUID()}@money.test`,
      billingAddress: address,
      shippingAddress: address,
      lineItems: [],
      subtotalMinor: 2_500,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 2_500,
      currency: 'GBP',
      createdAt: new Date(),
      capturedMinor: 2_500,
      refundedMinor: 0,
      captureMethod: 'import',
      paymentIntentId: intentId,
    })
    return {
      orderId,
      orderNumber,
      intentId,
      totalMinor: 2_500,
      currency: 'GBP',
      status: 'confirmed',
    }
  }

  for (const method of ['manual', 'import'] as const) {
    // Defect: a merchant-held order gains a refund from a refund of the duplicate capture.
    it(`AC-7: on a ${method} order a refund, even one carrying a duplicate-capture key, answers ignored not_provider_captured and leaves no row and the amounts as they were`, async () => {
      const order = await merchantHeld(method)
      const before = await storedMoney(raw, order.orderId)
      const listing = answerListWith(payments, (paymentId) => [
        listed(paymentId, {
          refundId: `re_dup_${randomUUID()}`,
          amountMinor: order.totalMinor,
          status: 'succeeded',
          idempotencyKey: uuidv7(),
        }),
        listed(paymentId, {
          refundId: `re_elsewhere_${randomUUID()}`,
          amountMinor: 1,
          status: 'succeeded',
        }),
      ])
      try {
        const answer = await deliverRefunded(served.baseUrl, order.intentId, {})
        expect(answer.status).toBe(200)
        expect(answer.data).toEqual({ ignored: true, reason: 'not_provider_captured' })
      } finally {
        listing.restore()
      }
      expect(await storedRefunds(raw, order.orderId)).toEqual([])
      expect(await storedMoney(raw, order.orderId)).toEqual(before)
    })
  }

  // Defect: a retryable delivery is swallowed: the claim is marked and the refund never recorded.
  it('AC-7: on a pending order with nothing captured the delivery answers 5xx and marks nothing; the same delivery after the capture records the refund', async () => {
    const started = await checkoutOf(k, await seedVariant(k, 3), 1)
    const eventId = `evt_${randomUUID()}`
    const body = {
      eventId,
      refund: { id: `re_dash_${randomUUID()}`, amountMinor: 200 },
    }

    const first = await deliverRefunded(served.baseUrl, started.paymentIntent.id, body)

    expect(first.status).toBeGreaterThanOrEqual(500)
    expect(await processedCount(raw, eventId)).toBe(0)
    expect(await storedRefunds(raw, started.orderId)).toEqual([])
    await deliverCapture(served.baseUrl, started)
    expect(await orderStatus(raw, started.orderId)).toBe('confirmed')

    const retried = await deliverRefunded(served.baseUrl, started.paymentIntent.id, body)
    expect(retried.status).toBe(200)
    expect(retried.data).toEqual({ reconciled: true, recorded: 1, settled: 0, failed: 0 })
    expect((await storedRefunds(raw, started.orderId)).map((r) => r.amountMinor)).toEqual([200])
  })

  // Defect: a provider outage swallows the delivery, or marks it delivered with nothing recorded.
  it('AC-7: a list that throws answers 5xx, marks nothing and makes no row; its retry records the refund', async () => {
    const order = await paidOrder(k)
    const eventId = `evt_${randomUUID()}`
    const providerId = `re_${randomUUID()}`
    const outage = answerListWith(payments, async () => {
      throw new Error('connection reset by the provider')
    })
    let first
    try {
      first = await deliverRefunded(served.baseUrl, order.intentId, { eventId })
    } finally {
      outage.restore()
    }
    expect(first.status).toBeGreaterThanOrEqual(500)
    expect(await processedCount(raw, eventId)).toBe(0)
    expect(await storedRefunds(raw, order.orderId)).toEqual([])

    const back = answerListWith(payments, (paymentId) => [
      listed(paymentId, { refundId: providerId, amountMinor: 700, status: 'succeeded' }),
    ])
    try {
      const retried = await deliverRefunded(served.baseUrl, order.intentId, { eventId })
      expect(retried.status).toBe(200)
      expect(await processedCount(raw, eventId)).toBe(1)
      expect((await storedRefunds(raw, order.orderId)).map((r) => r.providerRefundId)).toEqual([
        providerId,
      ])
    } finally {
      back.restore()
    }
  })

  it('AC-7: a delivered event answers deduped when repeated, adding nothing', async () => {
    const order = await paidOrder(k)
    const eventId = `evt_${randomUUID()}`
    const body = { eventId, refund: { id: `re_${randomUUID()}`, amountMinor: 300 } }
    const first = await deliverRefunded(served.baseUrl, order.intentId, body)
    expect(first.data).toEqual({ reconciled: true, recorded: 1, settled: 0, failed: 0 })

    const again = await deliverRefunded(served.baseUrl, order.intentId, body)
    expect(again.data).toEqual({ deduped: true })
    expect(await storedRefunds(raw, order.orderId)).toHaveLength(1)
  })

  // Defect: an order that moved on with no capture holds an endpoint in failure for Stripe's three days.
  it('AC-7: on a cancelled order with nothing captured the delivery answers 200 ignored capture_never_recorded, logs an error and asks the provider nothing', async () => {
    const started = await pendingOrder()
    await cancelled(started.orderId)
    const before = logs.calls.length
    const listing = answerListWith(payments, () => [])
    try {
      const answer = await deliverRefunded(served.baseUrl, started.paymentIntent.id, {})
      expect(answer.status).toBe(200)
      expect(answer.data).toEqual({ ignored: true, reason: 'capture_never_recorded' })
      expect(listing.calls()).toBe(0)
    } finally {
      listing.restore()
    }
    expect(errorsNaming(before, started.orderId).length).toBeGreaterThan(0)
  })
})

describe('a provider refund the order cannot hold', () => {
  async function deliverWith(order: PaidOrder, build: (intent: string) => ListedRefund[]) {
    const listing = answerListWith(payments, build)
    try {
      return await deliverRefunded(served.baseUrl, order.intentId, {})
    } finally {
      listing.restore()
    }
  }

  // Defect: one refund in another currency blocks the good one, or is recorded and breaks the money invariant.
  it('AC-8: a listed refund in another currency writes no row and no event and logs an error; the good refund in the same list applies and the delivery answers 200', async () => {
    const order = await paidOrder(k)
    const goodId = `re_good_${randomUUID()}`
    const foreignId = `re_foreign_${randomUUID()}`
    const before = logs.calls.length
    const answer = await deliverWith(order, (paymentId) => [
      listed(paymentId, { refundId: foreignId, amountMinor: 300, currency: 'USD' }),
      listed(paymentId, { refundId: goodId, amountMinor: 400, status: 'succeeded' }),
    ])

    expect(answer.status).toBe(200)
    expect((await storedRefunds(raw, order.orderId)).map((r) => r.providerRefundId)).toEqual([
      goodId,
    ])
    expect(await refundEvents(raw, 'payment.refunded.v1', order.orderId)).toHaveLength(1)
    expect(errorsNaming(before, order.orderId, foreignId).length).toBeGreaterThan(0)
  })

  // Defect: a refund past the capture is recorded and breaks refundedMinor ≤ capturedMinor.
  it('AC-8: a listed refund that would take refundedMinor past capturedMinor writes no row and no event and logs an error; the earlier refund in the same list applies', async () => {
    const order = await paidOrder(k)
    const captured = order.totalMinor
    const goodId = `re_good_${randomUUID()}`
    const overId = `re_over_${randomUUID()}`
    const good = captured - 200
    const before = logs.calls.length
    const answer = await deliverWith(order, (paymentId) => [
      listed(paymentId, { refundId: goodId, amountMinor: good, status: 'succeeded' }),
      listed(paymentId, { refundId: overId, amountMinor: 201, status: 'succeeded' }),
    ])

    expect(answer.status).toBe(200)
    const rows = await storedRefunds(raw, order.orderId)
    expect(rows.map((r) => r.providerRefundId)).toEqual([goodId])
    expect((await storedMoney(raw, order.orderId)).refundedMinor).toBe(good)
    expect(await allRefundEvents(raw, order.orderId)).toHaveLength(2)
    expect(errorsNaming(before, order.orderId, overId).length).toBeGreaterThan(0)
  })
})

describe('the audit trail of a provider refund', () => {
  async function entriesFor(orderId: string) {
    const entries = await activityEntries(session, { command: 'payment.finalize' })
    return entries.filter((e) =>
      (e['subjects'] as Array<{ id: string }> | undefined)?.some((s) => s.id === orderId),
    )
  }

  // Defect: a provider refund leaves no trail, or a no-op delivery writes an entry.
  it('AC-11: a webhook that records a provider refund adds one payment.finalize entry by system/stripe-webhook naming the order; a repeat and a delivery that changes nothing add none', async () => {
    const order = await paidOrder(k)
    const eventId = `evt_${randomUUID()}`
    const body = { eventId, refund: { id: `re_${randomUUID()}`, amountMinor: 300 } }
    const before = (await entriesFor(order.orderId)).length

    await deliverRefunded(served.baseUrl, order.intentId, body)
    const after = await entriesFor(order.orderId)
    expect(after.length).toBe(before + 1)
    const entry = after.at(-1)!
    expect(entry['actor']).toEqual({ kind: 'system', id: 'stripe-webhook' })
    expect(entry['subjects']).toContainEqual({ type: 'order', id: order.orderId })

    await deliverRefunded(served.baseUrl, order.intentId, body)
    await deliverRefunded(served.baseUrl, order.intentId, {})
    expect((await entriesFor(order.orderId)).length).toBe(after.length)
  })
})

describe('what a pending refund reads as', () => {
  async function pendingViaLostAnswer(order: PaidOrder, amount: number): Promise<string> {
    payments.refund = (async () => {
      throw new PaymentError('refund_unknown', 'answer lost')
    }) as PaymentsAdapter['refund']
    try {
      const res = await admin.call<{ refund: { id: string; status: string } }>(
        'POST',
        `/api/admin/orders/${order.orderId}/refund`,
        { amountMinor: amount },
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.data!.refund.status).toBe('pending')
      return res.body.data!.refund.id
    } finally {
      payments.refund = stubRefund as PaymentsAdapter['refund']
    }
  }

  async function keyOf(orderId: string): Promise<string> {
    const { key } = mintOrderKey()
    const now = new Date()
    await unaudited(() =>
      k.store.transaction((tx) =>
        k.repos.orderAccessKey.insert(tx, {
          id: randomUUID(),
          orderId,
          keyHash: hashOrderKey(key),
          purpose: 'checkout',
          createdAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        }),
      ),
    )
    return key
  }

  async function shopperRead(orderNumber: string, key: string) {
    await k.app.relay.drain()
    const res = await fetch(`${served.baseUrl}/api/orders/${orderNumber}`, {
      headers: { accept: 'application/json', [ORDER_KEY_HEADER]: key },
    })
    const body = (await res.json()) as {
      data: { payment?: { state?: string }; timeline?: Array<{ kind: string }> }
    }
    return body.data
  }

  async function adminRead(orderNumber: string): Promise<AdminOrder> {
    await k.app.relay.drain()
    const res = await admin.call<AdminOrder>('GET', `/api/admin/orders/${orderNumber}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.data!
  }

  const refundKinds = ['partially_refunded', 'refunded']

  // Defect: a pending refund shows as money moved, or the settle never reaches the reads.
  it('AC-13: a row left pending lists as pending, withheld from refundableMinor with refundedMinor unchanged, and the shopper reads paid with no refund entry; once it settles succeeded both read the refund', async () => {
    const order = await paidOrder(k)
    const key = await keyOf(order.orderId)
    const amount = 800
    const rowId = await pendingViaLostAnswer(order, amount)

    const adminPending = await adminRead(order.orderNumber)
    expect(adminPending.payment?.refunds.map((r) => [r.id, r.status])).toEqual([[rowId, 'pending']])
    expect(adminPending.payment?.refundableMinor).toBe(order.totalMinor - amount)
    expect(adminPending.payment?.refundedMinor).toBe(0)
    const shopperPending = await shopperRead(order.orderNumber, key)
    expect(shopperPending.payment?.state).toBe('paid')
    expect(shopperPending.timeline?.some((e) => refundKinds.includes(e.kind))).toBe(false)

    const listing = answerListWith(payments, (paymentId) => [
      listed(paymentId, {
        refundId: `re_${randomUUID()}`,
        amountMinor: amount,
        status: 'succeeded',
        idempotencyKey: rowId,
      }),
    ])
    try {
      const webhook = await deliverRefunded(served.baseUrl, order.intentId, {})
      expect(webhook.status).toBe(200)
    } finally {
      listing.restore()
    }

    const adminSettled = await adminRead(order.orderNumber)
    expect(adminSettled.payment?.refunds.map((r) => r.status)).toEqual(['succeeded'])
    expect(adminSettled.payment?.refundedMinor).toBe(amount)
    expect(adminSettled.payment?.state).toBe('partially_refunded')
    const shopperSettled = await shopperRead(order.orderNumber, key)
    expect(shopperSettled.payment?.state).toBe('partially_refunded')
    expect(shopperSettled.timeline?.some((e) => refundKinds.includes(e.kind))).toBe(true)
  })

  // Defect: a failed settle keeps the amount withheld, or shows the shopper a refund that moved no money.
  it('AC-13: after it settles failed the amount is refundable again and the shopper’s answer is unchanged', async () => {
    const order = await paidOrder(k)
    const key = await keyOf(order.orderId)
    const amount = 600
    const rowId = await pendingViaLostAnswer(order, amount)
    const shopperPending = await shopperRead(order.orderNumber, key)

    const listing = answerListWith(payments, (paymentId) => [
      listed(paymentId, {
        refundId: `re_${randomUUID()}`,
        amountMinor: amount,
        status: 'failed',
        idempotencyKey: rowId,
      }),
    ])
    try {
      await deliverRefunded(served.baseUrl, order.intentId, {})
    } finally {
      listing.restore()
    }

    const adminFailed = await adminRead(order.orderNumber)
    expect(adminFailed.payment?.refunds.map((r) => r.status)).toEqual(['failed'])
    expect(adminFailed.payment?.refundableMinor).toBe(order.totalMinor)
    expect(await shopperRead(order.orderNumber, key)).toEqual(shopperPending)
  })
})
