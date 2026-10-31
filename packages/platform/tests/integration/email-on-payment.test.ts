import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EVT_ORDER_PAID, type TransactionalEmail } from '@nymbalhq/types'
import { address, checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { unaudited } from '../support/write-audit.js'

// AC-13 on SQLite, through the kernel's own bus and email handler: the `order-placed` email goes on payment, once per
// order. A pending order sends nothing; its payment sends one; a second order.paid for the same order (a redelivered
// or replayed event) sends nothing more; an imported order, which publishes order.placed, sends nothing. Sends are
// read from the email adapter the handler calls, after the outbox has delivered every event.

describe('AC-13: one order-placed email per paid order (sqlite)', () => {
  let k: Kernel
  let raw: RawReader
  const sent: TransactionalEmail[] = []

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    raw = openRaw(k.dialect, k.target)
    const email = k.app.adapters.email
    const send = email.sendTransactional.bind(email)
    // The handler looks the method up at call time; the real (console) adapter still sends.
    email.sendTransactional = async (message) => {
      sent.push(message)
      return send(message)
    }
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await k?.close()
  })

  /** Waits until the outbox has handed every event to the bus, so every handler that will send has sent. */
  async function delivered(): Promise<void> {
    await vi.waitFor(
      async () => {
        const open = (await eventRows(raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
        expect(open.map((r) => r.type)).toEqual([])
      },
      { timeout: 10_000, interval: 20 },
    )
  }

  /**
   * A second order.paid for an order already confirmed, as a redelivered or replayed event would carry it. Published
   * straight through the kernel's publisher: mark-paid confirms only a pending order, so it cannot make one.
   */
  async function secondPaid(started: {
    orderId: string
    paymentIntent: { id: string }
    totalMinor: number
    currency: string
  }): Promise<void> {
    // A provider's repeat of the payment, appended by the test itself.
    await unaudited(() =>
      k.publisher.publish(EVT_ORDER_PAID, {
        orderId: started.orderId,
        paymentIntentId: started.paymentIntent.id,
        amountMinor: started.totalMinor,
        currency: started.currency,
      }),
    )
  }

  const orderPlacedTo = (to: string) =>
    sent.filter((m) => m.template === 'order-placed' && m.to === to)

  async function paidEvents(orderId: string): Promise<number> {
    return (await eventRows(raw, 'type = ?', ['order.paid.v1'])).filter(
      (r) => (r.envelope.payload as { orderId: string }).orderId === orderId,
    ).length
  }

  // Kills: the email still sent on order.placed (a pending order emails "confirmed"), and the idempotency keyed per
  // event, so a second order.paid for the order sends a second email.
  it('AC-13: a pending order sends no order-placed email; its payment sends one, to the buyer, naming the order; a second order.paid for it sends nothing more', async () => {
    const seeded = await seedVariant(k, 5)
    const buyer = `ac13-${randomUUID()}+stub-pending@checkout.test`
    const started = await checkoutOf(k, seeded, 1, buyer)
    await delivered()
    const atPlacement = orderPlacedTo(buyer).length

    await k.services.checkout.finalize(started.paymentIntent.id, {
      amountMinor: started.totalMinor,
      currency: started.currency,
    })
    await delivered()
    const afterPayment = orderPlacedTo(buyer).map((m) => m.vars['orderNumber'])

    await secondPaid(started)
    await delivered()

    expect(atPlacement).toBe(0)
    expect(afterPayment).toEqual([started.orderNumber])
    expect(await paidEvents(started.orderId)).toBe(2)
    expect(orderPlacedTo(buyer).length).toBe(afterPayment.length)
  })

  // Kills: the inline confirm and a later order.paid each counted as a payment to announce.
  it('AC-13: a checkout the stub pays inline sends one order-placed email; a second order.paid after the inline confirm sends nothing more', async () => {
    const seeded = await seedVariant(k, 5)
    const buyer = `ac13-inline-${randomUUID()}@checkout.test`
    const started = await checkoutOf(k, seeded, 1, buyer)
    await delivered()
    const afterCheckout = orderPlacedTo(buyer).length

    await secondPaid(started)
    await delivered()

    expect(afterCheckout).toBe(1)
    expect(await paidEvents(started.orderId)).toBe(2)
    expect(orderPlacedTo(buyer).length).toBe(afterCheckout)
  })

  // Kills: an import (which publishes order.placed for every historical order) emailing each imported customer.
  it('AC-13: an imported order publishes order.placed and sends no order-placed email', async () => {
    const customer = `ac13-import-${randomUUID()}@checkout.test`
    const before = (await eventRows(raw, 'type = ?', ['order.placed.v1'])).length
    await k.services.order.importOrder({
      orderId: uuidv7(),
      orderNumber: `IMP-${randomUUID().slice(0, 8)}`,
      status: 'confirmed',
      createdAt: new Date('2025-01-02T10:00:00Z'),
      customerId: null,
      email: customer,
      billingAddress: address,
      shippingAddress: address,
      lineItems: [],
      subtotalMinor: 4200,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 4200,
      currency: 'GBP',
      metadata: {},
    })
    await delivered()

    expect((await eventRows(raw, 'type = ?', ['order.placed.v1'])).length).toBe(before + 1)
    expect(orderPlacedTo(customer)).toEqual([])
  })
})
