import { createHash, randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import type { TransactionalEmail } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import {
  address,
  cartWith,
  checkoutOf,
  createKernel,
  seedVariant,
  type Kernel,
  type Seeded,
} from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'

// "Send me my order link" on SQLite, through the kernel's own bus and email handler with every send captured:
// POST /api/orders/link with { orderNumber, email } answers 202 with one body whatever it finds. Only a guest order at
// confirmed or later whose email matches gets a fresh email key and the order-placed email linking
// /order/<n>?key=<k>, an order with no key row included; a customer's order gets the email linking its account page
// and no key; a pending or cancelled order, a wrong email and an unknown number get nothing.

const STORE_URL = 'https://shop.test'
const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const ORDER_KEY = /^[A-Za-z0-9_-]{43}$/
const SAME_ANSWER = { data: { sent: 'if-matched' } }

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

let k: Kernel
let served: ServedKernel
let raw: RawReader
let seeded: Seeded
const sent: TransactionalEmail[] = []

beforeAll(async () => {
  k = await createKernel({
    dialect: 'sqlite',
    // Parsed again as loadConfig parses a store's file, so the schema's own handling of the URL applies.
    configure: (config) =>
      nymbalConfigSchema.parse({ ...config, store: { ...config.store, url: STORE_URL } }),
  })
  const email = k.app.adapters.email
  const send = email.sendTransactional.bind(email)
  // The handler looks the method up at call time; the real (console) adapter still sends.
  email.sendTransactional = async (message) => {
    sent.push(message)
    return send(message)
  }
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  seeded = await seedVariant(k, 200)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

/** Waits until the outbox has handed every event to the bus, so every handler that will send has sent. */
async function delivered(): Promise<void> {
  await vi.waitFor(
    async () => {
      const open = (await eventRows(raw)).filter((e) => e.deliveredAt == null && e.deadAt == null)
      expect(open.map((e) => e.type)).toEqual([])
    },
    { timeout: 10_000, interval: 20 },
  )
}

interface Target {
  label: string
  orderId: string
  orderNumber: string
  email: string
}

const buyer = (tag: string, trigger = '') =>
  `${tag}-${randomUUID().slice(0, 8)}${trigger}@order-link.test`

async function guestOrder(tag: string, trigger = ''): Promise<Target> {
  const email = buyer(tag, trigger)
  const started = await checkoutOf(k, seeded, 1, email)
  await delivered()
  return { label: tag, orderId: started.orderId, orderNumber: started.orderNumber, email }
}

async function customerOrder(tag: string): Promise<Target> {
  const email = buyer(tag)
  const { customer } = await k.services.auth.register({
    email,
    password: 'order-link-correct-horse',
  })
  const cartToken = await cartWith(k, seeded, 1)
  const started = await k.services.checkout.beginCheckout({
    cartToken,
    customerId: customer.id,
    email,
    billingAddress: address,
    shippingAddress: address,
  })
  await delivered()
  return { label: tag, orderId: started.orderId, orderNumber: started.orderNumber, email }
}

/** A guest order as the WooCommerce importer brings it: confirmed, and no key row. */
async function importedGuestOrder(tag: string): Promise<Target> {
  const email = buyer(tag)
  const order = await k.services.order.importOrder({
    orderId: uuidv7(),
    orderNumber: `WC-${Math.floor(Math.random() * 1e9)}`,
    status: 'confirmed',
    createdAt: new Date('2025-01-02T10:00:00Z'),
    customerId: null,
    email,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [
      {
        variantId: seeded.variantId,
        productId: seeded.productId,
        productName: 'Imported Widget',
        variantName: 'Default',
        sku: 'WC-LINK-1',
        qty: 1,
        unitPriceMinor: 1000,
        lineSubtotalMinor: 1000,
        lineTaxMinor: 0,
        lineTotalMinor: 1000,
        imageUrl: '',
      },
    ],
    subtotalMinor: 1000,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 1000,
    currency: 'GBP',
    metadata: {},
  })
  await delivered()
  return { label: tag, orderId: order.id, orderNumber: order.orderNumber, email }
}

async function requestLink(
  orderNumber: string,
  email: string,
): Promise<{ status: number; text: string }> {
  const shop = await primedShopper(served.baseUrl)
  const csrf = shop.jar.get('nymbal.csrf')!
  const res = await fetch(new URL('/api/orders/link', served.baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: `nymbal.csrf=${csrf}`,
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ orderNumber, email }),
  })
  const text = await res.text()
  await delivered()
  return { status: res.status, text }
}

const emailKeyRows = (orderId: string) =>
  raw.rows<{ key_hash: string }>(
    "SELECT key_hash FROM order_access_keys WHERE order_id = ? AND purpose = 'email'",
    [orderId],
  )

const orderPlacedTo = (to: string) =>
  sent.filter((m) => m.template === 'order-placed' && m.to === to)

const orderUrlOf = (m: TransactionalEmail): string =>
  typeof m.vars['orderUrl'] === 'string' ? m.vars['orderUrl'] : ''

async function readWithKey(
  orderNumber: string,
  key: string,
): Promise<{ status: number; orderNumber?: string }> {
  const res = await fetch(
    new URL(`/api/orders/${encodeURIComponent(orderNumber)}`, served.baseUrl),
    {
      headers: { accept: 'application/json', [ORDER_KEY_HEADER]: key },
    },
  )
  const body = (await res.json()) as { data?: { orderNumber: string } }
  return {
    status: res.status,
    ...(body.data !== undefined && { orderNumber: body.data.orderNumber }),
  }
}

describe('POST /api/orders/link', () => {
  // Kills: a route that says whether an order matched (a status or body that differs); one that sends on a mismatch,
  // a pending draft or a cancelled order; a fresh key that is never written, or written without being mailed; an
  // account holder's order mailed a URL key; a keyless order (old or imported) that can never be reopened.
  it('AC-3: a guest order at confirmed or later, with a key row or none, gets one new email key row and one order-placed email whose /order/<n>?key=<k> link reads it; a customer’s order gets one email linking /account/orders/<n> and no key row; a pending order, a cancelled one, a wrong email and an unknown number get no row and no email; every answer is 202 with the same body', async () => {
    const confirmed = await guestOrder('confirmed')
    const imported = await importedGuestOrder('imported')
    const owned = await customerOrder('owned')
    const pending = await guestOrder('pending', '+stub-pending')
    const cancelled = await guestOrder('cancelled', '+stub-pending')
    await k.services.order.cancel(
      cancelled.orderId,
      'shopper changed their mind',
      'admin:order-link',
    )
    await delivered()
    expect(
      (await emailKeyRows(imported.orderId)).length,
      'the imported order’s email key rows',
    ).toBe(0)

    const answers: Array<{ label: string; status: number; text: string }> = []
    const ask = async (label: string, orderNumber: string, email: string) => {
      const answer = await requestLink(orderNumber, email)
      expect(answer.status, `${label}: ${answer.text}`).toBe(202)
      answers.push({ label, ...answer })
    }

    // The guest orders that match: one key row and one mail each, whose link opens the order.
    for (const o of [confirmed, imported]) {
      const rowsBefore = (await emailKeyRows(o.orderId)).map((r) => r.key_hash)
      const mailsBefore = orderPlacedTo(o.email).length
      await ask(`${o.label}: a match`, o.orderNumber, o.email)
      const rowsAfter = (await emailKeyRows(o.orderId)).map((r) => r.key_hash)
      const mails = orderPlacedTo(o.email)
      expect(mails.length, `${o.label}: order-placed emails`).toBe(mailsBefore + 1)
      expect(rowsAfter.length, `${o.label}: email key rows`).toBe(rowsBefore.length + 1)
      const url = orderUrlOf(mails.at(-1)!)
      const key = url === '' ? '' : (new URL(url).searchParams.get('key') ?? '')
      expect(key, `${o.label}: the key in "${url}"`).toMatch(ORDER_KEY)
      expect(url, `${o.label}: the link`).toBe(
        `${STORE_URL}/order/${encodeURIComponent(o.orderNumber)}?key=${key}`,
      )
      expect(
        rowsAfter.filter((h) => !rowsBefore.includes(h)),
        `${o.label}: the new row`,
      ).toEqual([sha256(key)])
      expect(await readWithKey(o.orderNumber, key), `${o.label}: the mailed key`).toEqual({
        status: 200,
        orderNumber: o.orderNumber,
      })
    }

    // A customer's order: the account page, and no key.
    {
      const rowsBefore = (await emailKeyRows(owned.orderId)).length
      const mailsBefore = orderPlacedTo(owned.email).length
      await ask('owned: a match', owned.orderNumber, owned.email)
      const mails = orderPlacedTo(owned.email)
      expect(mails.length, 'owned: order-placed emails').toBe(mailsBefore + 1)
      expect(orderUrlOf(mails.at(-1)!), 'owned: the link').toBe(
        `${STORE_URL}/account/orders/${encodeURIComponent(owned.orderNumber)}`,
      )
      expect((await emailKeyRows(owned.orderId)).length, 'owned: email key rows').toBe(rowsBefore)
    }

    // Nothing for anything else, to anyone.
    const silent: Array<[string, string, string, Target | null]> = [
      ['pending: a match', pending.orderNumber, pending.email, pending],
      ['cancelled: a match', cancelled.orderNumber, cancelled.email, cancelled],
      ['confirmed: a wrong email', confirmed.orderNumber, `other-${confirmed.email}`, confirmed],
      ['an unknown number', `${confirmed.orderNumber}9`, confirmed.email, null],
    ]
    for (const [label, orderNumber, email, order] of silent) {
      const rows = async () => (order === null ? 0 : (await emailKeyRows(order.orderId)).length)
      const rowsBefore = await rows()
      const mailsBefore = sent.length
      await ask(label, orderNumber, email)
      expect(sent.length, `${label}: emails sent`).toBe(mailsBefore)
      expect(await rows(), `${label}: email key rows`).toBe(rowsBefore)
    }

    for (const a of answers) {
      expect(a.status, `${a.label}: status`).toBe(202)
      expect(JSON.parse(a.text), `${a.label}: body`).toEqual(SAME_ANSWER)
      expect(a.text, `${a.label}: the same bytes as the first answer`).toBe(answers[0]!.text)
    }
  })
})
