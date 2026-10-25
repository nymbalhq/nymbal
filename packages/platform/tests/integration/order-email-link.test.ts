import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import { EVT_ORDER_PAID, renderEmailTemplate, type TransactionalEmail } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'

// AC-4 on SQLite, through the kernel's own bus and email handler, with the email adapter's sends captured: with
// `store.url` set, the order-placed email of a paid guest order links to `/order/<n>?key=<k>` on the storefront, and
// `k` reads the order; a second order.paid sends nothing and mints no key. With no `store.url` the email is as it was:
// no link, no dangling line, no email key.

const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const ORDER_KEY = /^[A-Za-z0-9_-]{43}$/
/** How today's order-placed text ends, with no link. */
const TEXT_END = "We'll let you know when it ships."

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

interface Rig {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  sent: TransactionalEmail[]
}

async function rig(storeUrl?: string): Promise<Rig> {
  const k = await createKernel({
    dialect: 'sqlite',
    ...(storeUrl !== undefined && {
      // Parsed again as loadConfig parses a store's file, so the schema's own handling of the URL applies.
      configure: (config) =>
        nymbalConfigSchema.parse({ ...config, store: { ...config.store, url: storeUrl } }),
    }),
  })
  const sent: TransactionalEmail[] = []
  const email = k.app.adapters.email
  const send = email.sendTransactional.bind(email)
  // The handler looks the method up at call time; the real (console) adapter still sends.
  email.sendTransactional = async (message) => {
    sent.push(message)
    return send(message)
  }
  return { k, served: await serveKernel(k), raw: openRaw(k.dialect, k.target), sent }
}

/** Waits until the outbox has handed every event to the bus, so every handler that will send has sent. */
async function delivered(r: Rig): Promise<void> {
  await vi.waitFor(
    async () => {
      const open = (await eventRows(r.raw)).filter((e) => e.deliveredAt == null && e.deadAt == null)
      expect(open.map((e) => e.type)).toEqual([])
    },
    { timeout: 10_000, interval: 20 },
  )
}

const orderPlacedTo = (r: Rig, to: string) =>
  r.sent.filter((m) => m.template === 'order-placed' && m.to === to)

/** A paid guest order: the stub pays a checkout inline when the buyer's address carries no trigger. */
async function paidGuestOrder(r: Rig, tag: string) {
  const seeded = await seedVariant(r.k, 5)
  const buyer = `${tag}-${randomUUID()}@email-link.test`
  const started = await checkoutOf(r.k, seeded, 1, buyer)
  await delivered(r)
  return { ...started, buyer }
}

/** A second order.paid for an order already confirmed, as a redelivered or replayed event carries it. */
async function secondPaid(
  r: Rig,
  started: { orderId: string; paymentIntent: { id: string }; totalMinor: number; currency: string },
): Promise<void> {
  await r.k.publisher.publish(EVT_ORDER_PAID, {
    orderId: started.orderId,
    paymentIntentId: started.paymentIntent.id,
    amountMinor: started.totalMinor,
    currency: started.currency,
  })
  await delivered(r)
}

describe('AC-4: the order-placed email links to the order (sqlite)', () => {
  let linked: Rig
  let unlinked: Rig

  beforeAll(async () => {
    linked = await rig('https://shop.test/')
    unlinked = await rig()
  }, 60_000)

  afterAll(async () => {
    for (const r of [linked, unlinked]) {
      await r?.raw.close()
      await r?.served.stop()
    }
  })

  // Kills: no link; a link carrying the hash, or a key whose row was never written; a doubled slash from the
  // configured trailing one; a key minted on a redelivered order.paid.
  it('AC-4: with store.url https://shop.test/, a paid guest order’s order-placed email has orderUrl https://shop.test/order/<n>?key=<k>, its text contains it, k reads the order through x-nymbal-order-key, and a second order.paid sends nothing and adds no key row', async () => {
    const started = await paidGuestOrder(linked, 'linked')
    const mails = orderPlacedTo(linked, started.buyer)
    expect(mails.length, 'order-placed emails').toBe(1)
    const vars = mails[0]!.vars
    const orderUrl = typeof vars['orderUrl'] === 'string' ? vars['orderUrl'] : ''
    const key = orderUrl === '' ? '' : (new URL(orderUrl).searchParams.get('key') ?? '')

    expect(key, `the key in "${orderUrl}"`).toMatch(ORDER_KEY)
    expect(orderUrl).toBe(
      `https://shop.test/order/${encodeURIComponent(started.orderNumber)}?key=${key}`,
    )
    expect(renderEmailTemplate('order-placed', vars).text).toContain(orderUrl)

    const res = await fetch(
      new URL(`/api/orders/${encodeURIComponent(started.orderNumber)}`, linked.served.baseUrl),
      { headers: { accept: 'application/json', [ORDER_KEY_HEADER]: key } },
    )
    const body = (await res.json()) as { data?: { orderNumber: string } }
    expect([res.status, body.data?.orderNumber], 'the link’s key reads the order').toEqual([
      200,
      started.orderNumber,
    ])
    expect(
      await linked.raw.count('order_access_keys', 'order_id = ? AND key_hash = ? AND purpose = ?', [
        started.orderId,
        sha256(key),
        'email',
      ]),
      'the email key’s row',
    ).toBe(1)

    const rowsBefore = await linked.raw.count('order_access_keys', 'order_id = ?', [
      started.orderId,
    ])
    await secondPaid(linked, started)
    expect(orderPlacedTo(linked, started.buyer).length, 'emails after a second order.paid').toBe(
      mails.length,
    )
    expect(
      await linked.raw.count('order_access_keys', 'order_id = ?', [started.orderId]),
      'key rows after a second order.paid',
    ).toBe(rowsBefore)
  })

  // Kills: a link mailed with no storefront URL (a localhost link from a production store), and a dangling
  // "View your order:" line.
  it('AC-4: with store.url unset, the order-placed email has no orderUrl and no orderLink, its text has no "View your order" and no /order/ and ends as before, and no email key row is written', async () => {
    const started = await paidGuestOrder(unlinked, 'unlinked')
    const mails = orderPlacedTo(unlinked, started.buyer)
    expect(mails.length, 'order-placed emails').toBe(1)
    const vars = mails[0]!.vars
    const text = renderEmailTemplate('order-placed', vars).text

    expect(Object.keys(vars).filter((v) => v === 'orderUrl' || v === 'orderLink')).toEqual([])
    expect(text.includes('View your order'), text).toBe(false)
    expect(text.includes('/order/'), text).toBe(false)
    expect(text.endsWith(TEXT_END), text).toBe(true)
    expect(
      await unlinked.raw.count('order_access_keys', 'order_id = ? AND purpose = ?', [
        started.orderId,
        'email',
      ]),
      'email key rows',
    ).toBe(0)
  })
})
