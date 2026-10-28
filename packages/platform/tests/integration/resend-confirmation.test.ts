import { createHash, randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  EVT_ORDER_PAID,
  EVT_ORDER_PLACED,
  ORDER_STATUS_TRANSITIONS,
  renderEmailTemplate,
  type OrderLineItem,
  type OrderStatus,
  type TransactionalEmail,
} from '@nymbalhq/types'
import { fakeSmtpServer, type FakeSmtpServer } from '../../../../tests/support/smtp-server.js'
import {
  activityEntries,
  adminSession,
  auditRows,
  customerSession,
  IDEMPOTENCY_KEY,
  outcomesOf,
  rowsOf,
  type AdminSession,
  type Answer,
} from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq, type EventRow } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'

// The admin's resend of an order confirmation, on SQLite through the kernel's HTTP server, with the email adapter's
// sends recorded as they succeed; where a refusal is needed, the real SMTP adapter against the in-process mail host.
// What is asserted is what an admin, a shopper and a second connection see: the answer, the mail, the key it carries
// opening the order, the log, the audit entries and the order left as it was.

const RESEND_EVENT = 'order.confirmation_resend_requested.v1'
const COMMAND = 'order.resendConfirmation'
const ORDER_PAID_EMAIL = 'email:order-paid'
const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const ORDER_KEY = /^[A-Za-z0-9_-]{43}$/
const STORE_URL = 'https://shop.test'
const STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]
const REFUSED: readonly OrderStatus[] = ['pending', 'cancelled']

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const resendPath = (orderId: string) =>
  `/api/admin/orders/${encodeURIComponent(orderId)}/resend-confirmation`

interface Rig {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  admin: AdminSession
  /** Every transactional email the adapter accepted, in order. */
  sent: TransactionalEmail[]
  /** The relay's clock, moved by the tests that wait out a retry. */
  clock: { offset: number }
  close(): Promise<void>
}

async function rig(
  opts: {
    storeUrl?: string
    smtpPort?: number
    relay?: { maxAttempts?: number; retryDelayMs?: number }
  } = {},
): Promise<Rig> {
  const clock = { offset: 0 }
  const configure = (config: NymbalConfig): NymbalConfig =>
    // Parsed again as loadConfig parses a store's file, so the schema's own handling of the URL applies.
    nymbalConfigSchema.parse({
      ...config,
      store: { ...config.store, ...(opts.storeUrl !== undefined && { url: opts.storeUrl }) },
      commerce: {
        ...config.commerce,
        ...(opts.smtpPort !== undefined && {
          email: {
            provider: 'smtp',
            config: {
              from: 'shop@resend.test',
              smtp: { host: '127.0.0.1', port: opts.smtpPort, secure: false },
            },
          },
        }),
      },
    })
  const k = await createKernel({
    dialect: 'sqlite',
    configure,
    appOptions: {
      relay: { ...opts.relay, now: () => new Date(Date.now() + clock.offset) },
    },
  })
  const sent: TransactionalEmail[] = []
  const email = k.app.adapters.email
  const send = email.sendTransactional.bind(email)
  // The handler looks the method up at call time; the real adapter still sends, and a refused send is not recorded.
  email.sendTransactional = async (message) => {
    const result = await send(message)
    sent.push(message)
    return result
  }
  const served = await serveKernel(k)
  const raw = openRaw(k.dialect, k.target)
  const admin = await adminSession(k, served.baseUrl)
  return {
    k,
    served,
    raw,
    admin,
    sent,
    clock,
    async close() {
      await raw.close()
      await served.stop()
    },
  }
}

/** Drains the relay, then waits until no event is left that is due: every handler that will run now has run. */
async function settle(r: Rig): Promise<void> {
  await r.k.app.relay.drain()
  await vi.waitFor(
    async () => {
      const now = new Date(Date.now() + r.clock.offset).toISOString()
      const open = await r.raw.rows<{ type: string }>(
        'SELECT type FROM events WHERE delivered_at IS NULL AND dead_at IS NULL AND (retry_at IS NULL OR retry_at <= ?)',
        [now],
      )
      expect(open.map((e) => e.type)).toEqual([])
    },
    { timeout: 10_000, interval: 20 },
  )
}

const resend = (r: Rig, orderId: string, key: string = `resend.${randomUUID()}`) =>
  r.admin.send<{ orderId: string; orderNumber: string; email: string }>(
    'POST',
    resendPath(orderId),
    undefined,
    { [IDEMPOTENCY_KEY]: key },
  )

const orderPlacedTo = (r: Rig, to: string) =>
  r.sent.filter((m) => m.template === 'order-placed' && m.to === to)

const orderUrlOf = (m: TransactionalEmail): string =>
  typeof m.vars['orderUrl'] === 'string' ? m.vars['orderUrl'] : ''

const keyOf = (m: TransactionalEmail): string => {
  const url = orderUrlOf(m)
  return url === '' ? '' : (new URL(url).searchParams.get('key') ?? '')
}

/** The shopper's read of the order, with the key when one is given. */
async function shopperRead(r: Rig, orderNumber: string, key?: string) {
  const res = await fetch(
    new URL(`/api/orders/${encodeURIComponent(orderNumber)}`, r.served.baseUrl),
    {
      headers: { accept: 'application/json', ...(key !== undefined && { [ORDER_KEY_HEADER]: key }) },
    },
  )
  const body = (await res.json()) as { data?: { orderNumber?: string } }
  return { status: res.status, orderNumber: body.data?.orderNumber }
}

/** The events about the order appended above `seq`, by the subject the log gives them. */
async function orderEventsAfter(r: Rig, seq: number, orderId: string): Promise<EventRow[]> {
  return eventRows(r.raw, 'seq > ? AND subject_type = ? AND subject_id = ?', [seq, 'order', orderId])
}

const resendEventsAfter = async (r: Rig, seq: number, orderId: string) =>
  (await orderEventsAfter(r, seq, orderId)).filter((e) => e.type === RESEND_EVENT)

/** A paid guest order whose order.paid.v1 has run: the stub pays inline when the address carries no trigger. */
async function paidGuestOrder(r: Rig, tag: string) {
  const seeded = await seedVariant(r.k, 5)
  const buyer = `${tag}-${randomUUID()}@resend.test`
  const started = await checkoutOf(r.k, seeded, 1, buyer)
  await settle(r)
  return { ...started, buyer }
}

const line: OrderLineItem = {
  variantId: 'resend-variant',
  productId: 'resend-product',
  productName: 'Resend Widget',
  variantName: 'Default',
  sku: 'RESEND-1',
  qty: 1,
  unitPriceMinor: 2500,
  lineSubtotalMinor: 2500,
  lineTaxMinor: 0,
  lineTotalMinor: 2500,
  imageUrl: '',
}

const money = {
  lineItems: [line],
  subtotalMinor: 2500,
  taxTotalMinor: 0,
  shippingTotalMinor: 0,
  discountTotalMinor: 0,
  totalMinor: 2500,
  currency: 'GBP',
}

/** What an order in `status` has been paid and refunded: nothing before payment or once cancelled. */
function paymentFor(status: OrderStatus) {
  if (REFUSED.includes(status)) return {}
  const refundedMinor =
    status === 'refunded' ? money.totalMinor : status === 'partially_refunded' ? 1000 : 0
  return { capturedMinor: money.totalMinor, refundedMinor, captureMethod: 'import' as const }
}

/** A guest order in `status`, brought in by importOrder: no order.paid.v1, so no email of its own. */
async function importedGuestOrder(r: Rig, status: OrderStatus) {
  const email = `imported-${status}-${randomUUID()}@resend.test`
  const order = await r.k.services.order.importOrder({
    orderId: uuidv7(),
    orderNumber: `WC-${randomUUID().slice(0, 8)}`,
    status,
    createdAt: new Date('2025-01-02T10:00:00Z'),
    customerId: null,
    email,
    billingAddress: address,
    shippingAddress: address,
    ...money,
    ...paymentFor(status),
    metadata: {},
  })
  await settle(r)
  return { orderId: order.id, orderNumber: order.orderNumber, email }
}

/** A confirmed guest order as one placed before order keys: its row and its order.placed, and no key row. */
async function keylessGuestOrder(r: Rig) {
  const id = uuidv7()
  const orderNumber = `OLD-${randomUUID().slice(0, 8)}`
  const email = `keyless-${randomUUID()}@resend.test`
  const now = new Date()
  await r.k.store.transaction(async (tx) => {
    const sequence = await r.k.repos.orderSequence.nextSequence(tx)
    await r.k.repos.order.insert(tx, {
      id,
      orderNumber,
      sequence,
      customerId: null,
      status: 'confirmed',
      email,
      billingAddress: address,
      shippingAddress: address,
      ...money,
      notes: '',
      metadata: {},
      paymentIntentId: null,
      createdAt: now,
      updatedAt: now,
    })
    const order = await r.k.repos.order.findById(tx, id)
    await r.k.publisher.publish(EVT_ORDER_PLACED, { order: order! })
  })
  await settle(r)
  return { orderId: id, orderNumber, email }
}

/** Everything a resend must leave as it was: the order's row, its history rows, its document and its history tab. */
async function orderState(r: Rig, orderId: string, orderNumber: string) {
  const row = await r.raw.rows('SELECT * FROM orders WHERE id = ?', [orderId])
  const history = await r.raw.rows('SELECT * FROM order_history WHERE order_id = ? ORDER BY id', [
    orderId,
  ])
  const doc = await r.k.documentStore.get<{ status: string; history: unknown; timeline: unknown }>(
    'orders',
    orderNumber,
  )
  const tab = await r.admin.send('GET', `/api/admin/orders/${orderId}/history`)
  return {
    row,
    history,
    doc: { status: doc?.status, history: doc?.history, timeline: doc?.timeline },
    tab: [tab.status, tab.body],
  }
}

/** The order's entries for the command, as the Activity page lists them. */
async function resendEntries(r: Rig, orderId: string) {
  const entries = await activityEntries(r.admin, { command: COMMAND })
  return entries
    .filter((e) =>
      (e['subjects'] as Array<{ id: string }> | undefined)?.some((s) => s.id === orderId),
    )
    .map((e) => ({
      outcome: e['outcome'],
      actor: e['actor'],
      subjects: e['subjects'],
      correlationId: e['correlationId'],
    }))
}

const errorOf = (a: Answer) =>
  a.body.error as { code?: string; context?: { status?: string } } | undefined

describe('resending an order confirmation, with sends recorded (sqlite)', () => {
  let linked: Rig
  let unlinked: Rig

  beforeAll(async () => {
    linked = await rig({ storeUrl: `${STORE_URL}/` })
    unlinked = await rig()
  }, 60_000)

  afterAll(async () => {
    await linked?.close()
    await unlinked?.close()
  })

  // Kills: the stub answering without a command; `command: null`, so no entry; the event published outside the
  // command, under another correlation id; a history row or a status change written by the resend.
  it('AC-1: an admin’s resend of a paid order answers 200 with its id, number and email, appends exactly one order.confirmation_resend_requested.v1 with payload { orderId } about the order, lists one applied entry by that admin with the order as subject and the event’s correlation id, and leaves the order’s row, history rows, document timeline and history tab unchanged', async () => {
    const order = await paidGuestOrder(linked, 'ac1')
    const before = await orderState(linked, order.orderId, order.orderNumber)
    const seq = await maxSeq(linked.raw)

    const answer = await resend(linked, order.orderId)
    await settle(linked)

    expect([answer.status, answer.body.data], JSON.stringify(answer.body)).toEqual([
      200,
      { orderId: order.orderId, orderNumber: order.orderNumber, email: order.buyer },
    ])
    const events = await orderEventsAfter(linked, seq, order.orderId)
    expect(events.map((e) => e.type), 'events about the order after the resend').toEqual([
      RESEND_EVENT,
    ])
    expect(events[0]!.envelope.payload).toEqual({ orderId: order.orderId })
    expect(await resendEntries(linked, order.orderId)).toEqual([
      {
        outcome: 'applied',
        actor: { kind: 'admin', id: linked.admin.userId },
        subjects: [{ type: 'order', id: order.orderId }],
        correlationId: events[0]!.envelope.correlationId,
      },
    ])
    expect(events[0]!.envelope.correlationId).toBe(answer.correlationId)
    expect(await orderState(linked, order.orderId, order.orderNumber)).toEqual(before)
  })

  // Kills: a resend that republishes order.paid.v1 (swallowed by the once-per-order record); a key reused, stored in
  // plaintext or carried in the event; an earlier key revoked.
  it('AC-2: property: for k = 1-4 resends of a paid order, each with its own Idempotency-Key, the buyer gets k more order-placed emails linking to https://shop.test/order/<n>?key=<k_i> with distinct keys that each open the order; the checkout’s and the first email’s keys still open it; the order gains k email key rows holding the keys’ sha256, and no key is in the log, an entry or an answer', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (n) => {
        const order = await paidGuestOrder(linked, 'ac2')
        const first = orderPlacedTo(linked, order.buyer)
        expect(first.length, 'the paid checkout’s own email').toBe(1)
        const firstKey = keyOf(first[0]!)
        const seq = await maxSeq(linked.raw)
        const rowsBefore = await linked.raw.count(
          'order_access_keys',
          'order_id = ? AND purpose = ?',
          [order.orderId, 'email'],
        )

        const answers: Answer[] = []
        for (let i = 0; i < n; i += 1) answers.push(await resend(linked, order.orderId))
        await settle(linked)

        const mails = orderPlacedTo(linked, order.buyer)
        expect(mails.length, `order-placed emails after ${n} resends`).toBe(first.length + n)
        const fresh = mails.slice(first.length)
        const keys = fresh.map(keyOf)
        for (const [i, m] of fresh.entries()) {
          expect(keys[i], `the key in "${orderUrlOf(m)}"`).toMatch(ORDER_KEY)
          expect(orderUrlOf(m)).toBe(
            `${STORE_URL}/order/${encodeURIComponent(order.orderNumber)}?key=${keys[i]}`,
          )
          expect(renderEmailTemplate('order-placed', m.vars).text).toContain(orderUrlOf(m))
        }
        expect(new Set([firstKey, ...keys]).size, 'distinct keys').toBe(n + 1)

        for (const key of [order.orderKey, firstKey, ...keys]) {
          expect(await shopperRead(linked, order.orderNumber, key), `the key ${key}`).toEqual({
            status: 200,
            orderNumber: order.orderNumber,
          })
        }

        const hashes = (
          await linked.raw.rows<{ key_hash: string }>(
            'SELECT key_hash FROM order_access_keys WHERE order_id = ? AND purpose = ?',
            [order.orderId, 'email'],
          )
        ).map((h) => h.key_hash)
        expect(hashes.length, 'email key rows').toBe(rowsBefore + n)
        expect([...hashes].sort()).toEqual([firstKey, ...keys].map(sha256).sort())
        expect(hashes.filter((h) => [firstKey, ...keys].includes(h))).toEqual([])

        const written = JSON.stringify([
          await eventRows(linked.raw, 'seq > ?', [seq]),
          await auditRows(linked.raw, 'command = ?', [COMMAND]),
          answers.map((a) => a.body),
        ])
        expect(keys.filter((key) => written.includes(key)), 'keys in the log, entries or answers').toEqual(
          [],
        )
      }),
      { numRuns: 5, endOnFailure: true },
    )
  })

  // Kills: the schema keeps `command: null`, so the key is ignored and every POST sends.
  it('AC-5: two POSTs with one Idempotency-Key, one after the other and then two at once under another key, make one event, one applied entry and one email per key; the second answer of each pair repeats the first’s status and body with Idempotent-Replayed: true', async () => {
    const order = await paidGuestOrder(linked, 'ac5')
    const seq = await maxSeq(linked.raw)
    const mailsBefore = orderPlacedTo(linked, order.buyer).length
    const sequentialKey = `ac5.seq.${randomUUID()}`
    const concurrentKey = `ac5.con.${randomUUID()}`

    const pairs: Array<[string, Answer[]]> = [
      [
        sequentialKey,
        [await resend(linked, order.orderId, sequentialKey), await resend(linked, order.orderId, sequentialKey)],
      ],
      [
        concurrentKey,
        await Promise.all([
          resend(linked, order.orderId, concurrentKey),
          resend(linked, order.orderId, concurrentKey),
        ]),
      ],
    ]
    await settle(linked)

    const events = await resendEventsAfter(linked, seq, order.orderId)
    for (const [key, answers] of pairs) {
      const context = `${key}: ${JSON.stringify(answers.map((a) => [a.status, a.replayed, a.body]))}`
      const applied = answers.filter((a) => a.replayed !== 'true')
      expect(applied.length, `answers without Idempotent-Replayed (${context})`).toBe(1)
      expect(applied[0]!.status, context).toBe(200)
      expect(
        answers.map((a) => [a.status, a.body, a.replayed === 'true']).sort((x, y) => Number(x[2]) - Number(y[2])),
        context,
      ).toEqual([
        [applied[0]!.status, applied[0]!.body, false],
        [applied[0]!.status, applied[0]!.body, true],
      ])
      expect(
        events.filter((e) => e.envelope.correlationId === applied[0]!.correlationId).length,
        `events for ${key}`,
      ).toBe(1)
      expect(outcomesOf(await auditRows(linked.raw, 'idempotency_key = ?', [key])), context).toEqual([
        'applied',
        'replayed',
      ])
    }
    expect(events.length, 'resend events for the order').toBe(pairs.length)
    expect(orderPlacedTo(linked, order.buyer).length - mailsBefore, 'emails sent').toBe(pairs.length)
  })

  // Kills: a pending or cancelled order mailed a confirmation; a refusal published or left unrecorded; a paid status
  // refused.
  it('AC-6: property over statuses: a resend answers 200 and publishes one event and one email for confirmed, processing, shipped, delivered, partially_refunded and refunded orders, and for pending and cancelled answers 409 order.unpaid with context.status, publishes and sends nothing and leaves one refused entry', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...STATUSES), async (status) => {
        const refused = REFUSED.includes(status)
        const order = await importedGuestOrder(linked, status)
        const seq = await maxSeq(linked.raw)

        const answer = await resend(linked, order.orderId)
        await settle(linked)

        const context = `${status}: ${answer.status} ${JSON.stringify(answer.body)}`
        expect(
          [answer.status, errorOf(answer)?.code, errorOf(answer)?.context?.status],
          context,
        ).toEqual(refused ? [409, 'order.unpaid', status] : [200, undefined, undefined])
        expect(
          (await resendEventsAfter(linked, seq, order.orderId)).length,
          `events (${context})`,
        ).toBe(refused ? 0 : 1)
        expect(orderPlacedTo(linked, order.email).length, `emails (${context})`).toBe(
          refused ? 0 : 1,
        )
        const rows = await rowsOf(linked.raw, answer.correlationId)
        expect(
          rows.map((row) => [row.command, row.outcome]),
          `entries (${context})`,
        ).toEqual([[COMMAND, refused ? 'refused' : 'applied']])
      }),
      { numRuns: STATUSES.length, examples: STATUSES.map((s) => [s]), endOnFailure: true },
    )
  })

  // Kills: an unknown order answered as resent; a guest or a customer able to resend.
  it('AC-6: an unknown id answers 404 not_found; no session answers 401 and a customer’s bearer 403, and neither publishes an event or writes an entry', async () => {
    const unknown = await resend(linked, uuidv7())
    expect([unknown.status, errorOf(unknown)?.code], JSON.stringify(unknown.body)).toEqual([
      404,
      'not_found',
    ])

    const order = await importedGuestOrder(linked, 'confirmed')
    const seq = await maxSeq(linked.raw)
    const guest = await primedShopper(linked.served.baseUrl)
    const customer = await customerSession(linked.served.baseUrl)
    const noSession = await guest.call('POST', resendPath(order.orderId), undefined, {
      headers: { [IDEMPOTENCY_KEY]: `ac6.guest.${randomUUID()}` },
    })
    const asCustomer = await customer.send('POST', resendPath(order.orderId), undefined, {
      [IDEMPOTENCY_KEY]: `ac6.customer.${randomUUID()}`,
    })
    await settle(linked)

    expect([
      [noSession.status, noSession.body.error?.code],
      [asCustomer.status, errorOf(asCustomer)?.code],
    ]).toEqual([
      [401, 'auth.unauthorized'],
      [403, 'auth.forbidden'],
    ])
    expect((await resendEventsAfter(linked, seq, order.orderId)).length).toBe(0)
    expect(await rowsOf(linked.raw, noSession.headers.get('x-correlation-id'))).toEqual([])
    expect(await rowsOf(linked.raw, asCustomer.correlationId)).toEqual([])
  })

  // Kills: a resend that only re-sends an existing link; the key row written for another order.
  it('AC-7: a confirmed guest order with no key row and a guest order imported as processing each answer 404 to any key; after a resend the mailed key opens each and no other, and with no key each still answers 404', async () => {
    const orders = [
      { label: 'written with no key', ...(await keylessGuestOrder(linked)) },
      { label: 'imported as processing', ...(await importedGuestOrder(linked, 'processing')) },
    ]
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...orders),
        fc.stringMatching(ORDER_KEY),
        async (o, key) => {
          expect((await shopperRead(linked, o.orderNumber, key)).status, `${o.label}, ${key}`).toBe(
            404,
          )
        },
      ),
      { numRuns: 10 },
    )

    for (const o of orders) {
      const answer = await resend(linked, o.orderId)
      expect(answer.status, `${o.label}: ${JSON.stringify(answer.body)}`).toBe(200)
    }
    await settle(linked)

    const mailed = orders.map((o) => {
      const mails = orderPlacedTo(linked, o.email)
      expect(mails.length, `${o.label}: order-placed emails`).toBe(1)
      return keyOf(mails[0]!)
    })
    for (const [i, o] of orders.entries()) {
      const other = orders[1 - i]!
      expect(
        [
          await shopperRead(linked, o.orderNumber, mailed[i]),
          (await shopperRead(linked, other.orderNumber, mailed[i])).status,
          (await shopperRead(linked, o.orderNumber)).status,
        ],
        o.label,
      ).toEqual([{ status: 200, orderNumber: o.orderNumber }, 404, 404])
      expect(
        await linked.raw.count('order_access_keys', 'order_id = ? AND key_hash = ?', [
          o.orderId,
          sha256(mailed[i]!),
        ]),
        `${o.label}: the mailed key's row`,
      ).toBe(1)
    }
  })

  // Kills: a localhost or `undefined` link mailed from a store with no storefront URL; a key minted for no link.
  it('AC-8: with store.url unset, a resend answers and is entered as an admin’s applied command, and sends order-placed with no orderUrl or orderLink, no "View your order" in its text, and no key row', async () => {
    const order = await paidGuestOrder(unlinked, 'ac8')
    const mailsBefore = orderPlacedTo(unlinked, order.buyer).length
    const keyRowsBefore = await unlinked.raw.count('order_access_keys', 'order_id = ? AND purpose = ?', [
      order.orderId,
      'email',
    ])
    const seq = await maxSeq(unlinked.raw)

    const answer = await resend(unlinked, order.orderId)
    await settle(unlinked)

    expect([answer.status, answer.body.data], JSON.stringify(answer.body)).toEqual([
      200,
      { orderId: order.orderId, orderNumber: order.orderNumber, email: order.buyer },
    ])
    const events = await resendEventsAfter(unlinked, seq, order.orderId)
    expect(events.length, 'resend events').toBe(1)
    expect(await resendEntries(unlinked, order.orderId)).toEqual([
      {
        outcome: 'applied',
        actor: { kind: 'admin', id: unlinked.admin.userId },
        subjects: [{ type: 'order', id: order.orderId }],
        correlationId: events[0]!.envelope.correlationId,
      },
    ])
    const mails = orderPlacedTo(unlinked, order.buyer)
    expect(mails.length, 'order-placed emails').toBe(mailsBefore + 1)
    const vars = mails.at(-1)!.vars
    const text = renderEmailTemplate('order-placed', vars).text
    expect(Object.keys(vars).filter((v) => v === 'orderUrl' || v === 'orderLink')).toEqual([])
    expect([text.includes('View your order'), text.includes('/order/')], text).toEqual([false, false])
    expect(
      await unlinked.raw.count('order_access_keys', 'order_id = ? AND purpose = ?', [
        order.orderId,
        'email',
      ]),
      'email key rows',
    ).toBe(keyRowsBefore)
  })
})

describe('resending an order confirmation through a mail host that refuses (sqlite)', () => {
  const RETRY_DELAY_MS = 60_000
  const DAY_MS = 24 * 60 * 60_000
  let smtp: FakeSmtpServer
  /** Dead after one failed attempt. */
  let once: Rig
  /** Retried after RETRY_DELAY_MS, doubling, on its own clock. */
  let retrying: Rig

  beforeAll(async () => {
    smtp = await fakeSmtpServer()
    once = await rig({ storeUrl: STORE_URL, smtpPort: smtp.port, relay: { maxAttempts: 1 } })
    retrying = await rig({
      storeUrl: STORE_URL,
      smtpPort: smtp.port,
      relay: { retryDelayMs: RETRY_DELAY_MS },
    })
  }, 60_000)

  afterAll(async () => {
    await once?.close()
    await retrying?.close()
    await smtp?.close()
  })

  const messagesTo = (to: string) => smtp.recipients.filter((rcpt) => rcpt.includes(to)).length

  const paidRow = async (r: Rig, seq: number, orderId: string) => {
    const rows = (await eventRows(r.raw, 'seq > ? AND type = ?', [seq, EVT_ORDER_PAID])).filter(
      (e) => (e.envelope.payload as { orderId?: string }).orderId === orderId,
    )
    expect(rows.length, 'order.paid.v1 rows for the checkout').toBe(1)
    return rows[0]!
  }

  const paidEmailRecords = (r: Rig, orderId: string) =>
    r.raw.count('processed_events', 'handler_name = ? AND event_id = ?', [ORDER_PAID_EMAIL, orderId])

  // Kills: a resend that reads or needs the email:order-paid record.
  it('AC-3: with the mail host refusing and one attempt allowed, a paid checkout leaves no message, its order.paid.v1 dead and no email:order-paid record; with the refusal over, a resend sends one order-placed message whose key opens the order', async () => {
    const seeded = await seedVariant(once.k, 5)
    const buyer = `ac3-dead-${randomUUID()}@resend.test`
    const seq = await maxSeq(once.raw)
    smtp.refuseRecipients(1)
    const started = await checkoutOf(once.k, seeded, 1, buyer)
    await settle(once)

    const paid = await paidRow(once, seq, started.orderId)
    expect([messagesTo(buyer), paid.attempts, paid.deadAt !== null && paid.deadAt !== undefined]).toEqual([
      0,
      1,
      true,
    ])
    expect(await paidEmailRecords(once, started.orderId)).toBe(0)

    const answer = await resend(once, started.orderId)
    await settle(once)

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(messagesTo(buyer), 'messages to the buyer after the resend').toBe(1)
    const mails = orderPlacedTo(once, buyer)
    expect(mails.length, 'order-placed emails accepted').toBe(1)
    expect(await shopperRead(once, started.orderNumber, keyOf(mails[0]!))).toEqual({
      status: 200,
      orderNumber: started.orderNumber,
    })
  })

  // Kills: a resend that waits on order.paid.v1's delivery.
  it('AC-3: with order.paid.v1 failed once and its retry ahead, a resend sends one order-placed message whose key opens the order before that retry runs', async () => {
    const seeded = await seedVariant(retrying.k, 5)
    const buyer = `ac3-waiting-${randomUUID()}@resend.test`
    const seq = await maxSeq(retrying.raw)
    smtp.refuseRecipients(1)
    const started = await checkoutOf(retrying.k, seeded, 1, buyer)
    await settle(retrying)
    const waiting = await paidRow(retrying, seq, started.orderId)
    expect([messagesTo(buyer), waiting.attempts, waiting.deliveredAt ?? null, waiting.deadAt ?? null]).toEqual([
      0,
      1,
      null,
      null,
    ])

    const answer = await resend(retrying, started.orderId)
    await settle(retrying)

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(messagesTo(buyer), 'messages to the buyer after the resend').toBe(1)
    const still = await paidRow(retrying, seq, started.orderId)
    expect([still.attempts, still.deliveredAt ?? null], 'order.paid.v1 not yet retried').toEqual([
      waiting.attempts,
      null,
    ])
    const mails = orderPlacedTo(retrying, buyer)
    expect(mails.length, 'order-placed emails accepted').toBe(1)
    expect(await shopperRead(retrying, started.orderNumber, keyOf(mails[0]!))).toEqual({
      status: 200,
      orderNumber: started.orderNumber,
    })
  })

  // Kills: the send made in the request, or an error swallowed, so nothing retries; the record written before the
  // send, so the retry is skipped.
  it('AC-4: with the mail host refusing the next recipient with 451, a resend leaves no message and its event undelivered with attempts 1; after the retry wait one message reaches the buyer and the event is delivered; a further drain sends nothing more', async () => {
    const order = await paidGuestOrder(retrying, 'ac4')
    expect(messagesTo(order.buyer), 'the paid checkout’s own email').toBe(1)
    const seq = await maxSeq(retrying.raw)
    smtp.refuseRecipients(1)

    const answer = await resend(retrying, order.orderId)
    await settle(retrying)

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const failed = await resendEventsAfter(retrying, seq, order.orderId)
    expect(
      failed.map((e) => [e.attempts, e.deliveredAt ?? null]),
      'the resend event after the refusal',
    ).toEqual([[1, null]])
    expect(messagesTo(order.buyer), 'messages after the refusal').toBe(1)

    retrying.clock.offset += DAY_MS
    await settle(retrying)

    expect(messagesTo(order.buyer), 'messages after the retry').toBe(2)
    const retried = await resendEventsAfter(retrying, seq, order.orderId)
    expect(retried.map((e) => [e.attempts, e.deliveredAt != null])).toEqual([[failed[0]!.attempts, true]])

    retrying.clock.offset += DAY_MS
    await settle(retrying)
    expect(messagesTo(order.buyer), 'messages after a further drain').toBe(2)
  })
})
