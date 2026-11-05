import { createHash, randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  EVT_ORDER_CONFIRMATION_RESEND_REQUESTED,
  EVT_ORDER_SHIPPED,
  normaliseTrackingNumber,
  renderEmailTemplate,
  type Address,
  type OrderLineItem,
  type OrderStatus,
  type TransactionalEmail,
} from '@nymbalhq/types'
import { adminSession, IDEMPOTENCY_KEY, type AdminSession } from '../support/audit-http.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq, type EventRow } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { captureLogs, stringsIn, type LogCapture, type LogRecord } from '../support/settings.js'
import { unaudited } from '../support/write-audit.js'

// The shipped email on SQLite, through the kernel's HTTP server, its bus, relay and email handler, with the email
// adapter's sends captured (attempts and accepted sends apart) and the kernel's log kept. What is asserted is what the
// shopper is sent, what a second connection reads (key rows, processed records, the event log) and what the email
// handler logs; nothing reads how the handler builds the email.

const STORE_URL = 'https://shop.test/'
const KEY_LIFETIME = '7d'
const KEY_LIFETIME_MS = 7 * 24 * 3_600_000
const SHIPPED = 'order-shipped'
const PLACED = 'order-placed'
const SHIPPED_RECORD = 'email:order-shipped'
const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const ORDER_KEY = /^[A-Za-z0-9_-]{43}$/
const USPS_NUMBER = '9400 1000 0000 0000 0000 01'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

interface Rig {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  admin: AdminSession
  logs: LogCapture
  /** Every send the handler attempted, accepted or not. */
  attempted: TransactionalEmail[]
  /** Every send the adapter accepted. */
  sent: TransactionalEmail[]
  /** The next this many order-shipped sends throw. */
  failShipped: { left: number }
  close(): Promise<void>
}

async function rig(opts: { storeUrl?: string } = {}): Promise<Rig> {
  const logs = captureLogs()
  const configure = (config: NymbalConfig): NymbalConfig =>
    // Parsed again as loadConfig parses a store's file, so the schema's own handling of the URL applies.
    nymbalConfigSchema.parse({
      ...config,
      store: { ...config.store, ...(opts.storeUrl !== undefined && { url: opts.storeUrl }) },
      commerce: {
        ...config.commerce,
        orders: {
          ...config.commerce.orders,
          keyLifetime: { ...config.commerce.orders.keyLifetime, email: KEY_LIFETIME },
        },
      },
    })
  const k = await createKernel({ dialect: 'sqlite', configure, logger: logs.logger })
  const attempted: TransactionalEmail[] = []
  const sent: TransactionalEmail[] = []
  const failShipped = { left: 0 }
  const email = k.app.adapters.email
  const send = email.sendTransactional.bind(email)
  // The handler looks the method up at call time; the real (console) adapter still sends what is not refused here.
  email.sendTransactional = async (message) => {
    attempted.push(message)
    if (message.template === SHIPPED && failShipped.left > 0) {
      failShipped.left -= 1
      throw new Error('the mail host refused the send')
    }
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
    logs,
    attempted,
    sent,
    failShipped,
    async close() {
      await raw.close()
      await served.stop()
    },
  }
}

/** Hands the log to the bus until every event is delivered or dead: every handler that will send has sent. */
async function settle(r: Rig): Promise<void> {
  await vi.waitFor(
    async () => {
      await r.k.app.relay.drain()
      const open = (await eventRows(r.raw)).filter((e) => e.deliveredAt == null && e.deadAt == null)
      expect(open.map((e) => e.type)).toEqual([])
    },
    { timeout: 15_000, interval: 20 },
  )
}

interface LineSpec {
  productName: string
  variantName: string
  qty: number
}

const TWO_LINES: LineSpec[] = [
  { productName: 'Cedar Lantern', variantName: 'Forest Green', qty: 2 },
  { productName: 'Wool Throw', variantName: '', qty: 3 },
]

interface Placed {
  orderId: string
  orderNumber: string
  buyer: string
}

/** A paid order of `lines` (each a product of its own), paid inline by the stub: the buyer's address has no trigger. */
async function paidOrder(
  r: Rig,
  opts: { lines?: LineSpec[]; customerId?: string; buyer?: string; firstName?: string } = {},
): Promise<Placed> {
  const lines = opts.lines ?? [{ productName: 'Shipped Widget', variantName: 'Default', qty: 1 }]
  const buyer = opts.buyer ?? `shipped-${randomUUID()}@shipped-email.test`
  const cart = await r.k.services.cart.getOrCreate(undefined, opts.customerId ?? null)
  for (const line of lines) {
    const tag = randomUUID()
    const product = await r.k.services.product.create({
      slug: `shipped-${tag}`,
      name: line.productName,
      description: '',
      status: 'active',
      variants: [
        {
          sku: `SHIP-${tag}`,
          name: line.variantName === '' ? 'Default' : line.variantName,
          priceMinor: 1000,
          stock: 10,
          lowStockThreshold: 0,
          options: [],
        },
      ],
    })
    await r.k.services.cart.addItem(cart.token, {
      variantId: product.variants[0]!.id,
      productId: product.id,
      productName: line.productName,
      variantName: line.variantName,
      priceMinor: 1000,
      imageUrl: '',
      qty: line.qty,
    })
  }
  const billingAddress: Address =
    opts.firstName === undefined ? address : { ...address, firstName: opts.firstName }
  const started = await r.k.services.checkout.beginCheckout({
    cartToken: cart.token,
    ...(opts.customerId !== undefined && { customerId: opts.customerId }),
    email: buyer,
    billingAddress,
    shippingAddress: address,
  })
  await settle(r)
  return { orderId: started.orderId, orderNumber: started.orderNumber, buyer }
}

async function processing(r: Rig, orderId: string): Promise<void> {
  await r.k.services.order.updateStatus(orderId, 'processing', 'shipped-email-test')
  await settle(r)
}

const shipPath = (orderId: string) => `/api/admin/orders/${encodeURIComponent(orderId)}/ship`

/** The admin's ship, as the order page's dialog sends it. */
async function ship(r: Rig, orderId: string, carrier: string, trackingNumber: string) {
  const answer = await r.admin.send<{ status: string }>('POST', shipPath(orderId), {
    carrier,
    trackingNumber,
  })
  return { status: answer.status, orderStatus: answer.body.data?.status }
}

const shippedTo = (r: Rig, orderNumber: string) =>
  r.sent.filter((m) => m.template === SHIPPED && m.vars['orderNumber'] === orderNumber)

const placedFor = (r: Rig, orderNumber: string) =>
  r.sent.filter((m) => m.template === PLACED && m.vars['orderNumber'] === orderNumber)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The order.shipped.v1 rows for the order, in log order. */
async function shippedEvents(r: Rig, orderId: string): Promise<EventRow[]> {
  return (await eventRows(r.raw, 'type = ?', [EVT_ORDER_SHIPPED])).filter(
    (e) => (e.envelope.payload as { orderId?: string }).orderId === orderId,
  )
}

const processed = (r: Rig, handler: string, eventId: string) =>
  r.raw.count('processed_events', 'handler_name = ? AND event_id = ?', [handler, eventId])

const keyRows = (r: Rig, orderId: string, purpose?: 'email' | 'checkout') =>
  purpose === undefined
    ? r.raw.count('order_access_keys', 'order_id = ?', [orderId])
    : r.raw.count('order_access_keys', 'order_id = ? AND purpose = ?', [orderId, purpose])

async function statusOf(r: Rig, orderId: string): Promise<string> {
  return (await r.raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [orderId]))
    .status
}

/** Lines of `itemsList` with any text on them. */
const itemLines = (vars: Record<string, unknown>): string[] =>
  str(vars['itemsList'])
    .split('\n')
    .filter((line) => line.trim() !== '')

/** Whether `line` holds `n` as a number of its own, not as a digit of another. */
const holdsNumber = (line: string, n: number): boolean =>
  new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(line)

/** The lines the email handler logged from `from` on (its logger is bound `handler: 'email'`). */
const handlerLines = (r: Rig, from: number): LogRecord[] =>
  r.logs.calls.slice(from).filter((c) => c.bindings['handler'] === 'email')

/** The handler's lines that name any of `ids`, as level, field names and the two ids. */
function linesNaming(lines: LogRecord[], ids: string[]) {
  return lines
    .filter((c) => stringsIn([c.obj, c.msg]).some((s) => ids.some((id) => s.includes(id))))
    .map((c) => {
      const obj = (c.obj ?? {}) as Record<string, unknown>
      return [c.level, Object.keys(obj).sort(), obj['orderId'], obj['eventId']]
    })
}

const line = (name: string): OrderLineItem => ({
  variantId: `imported-variant-${name}`,
  productId: `imported-product-${name}`,
  productName: name,
  variantName: 'Default',
  sku: `IMP-${name}`,
  qty: 1,
  unitPriceMinor: 2500,
  lineSubtotalMinor: 2500,
  lineTaxMinor: 0,
  lineTotalMinor: 2500,
  imageUrl: '',
})

/** An order brought in by importOrder, paid at the source: no order.paid.v1, so no email of its own. */
async function importedOrder(r: Rig, status: OrderStatus, email: string): Promise<Placed> {
  const order = await r.k.services.order.importOrder({
    orderId: uuidv7(),
    orderNumber: `WC-${randomUUID().slice(0, 8)}`,
    status,
    createdAt: new Date('2025-01-02T10:00:00Z'),
    customerId: null,
    email,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [line('Imported Kettle')],
    subtotalMinor: 2500,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 2500,
    currency: 'GBP',
    capturedMinor: 2500,
    refundedMinor: 0,
    captureMethod: 'import',
    metadata: {},
  })
  await settle(r)
  return { orderId: order.id, orderNumber: order.orderNumber, buyer: email }
}

/** The importer's placeholders for an address it does not have, and an empty one. */
const placeholderAddresses = (): Array<[string, string]> => [
  ['wc-<id>@unknown.nymbal.local', `wc-${randomUUID().slice(0, 8)}@unknown.nymbal.local`],
  [
    'order-<hash>@imported.nymbal.local',
    `order-${sha256(randomUUID()).slice(0, 16)}@imported.nymbal.local`,
  ],
  ['""', ''],
]

const freshNumber = (): string =>
  `NOADDR${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`

describe('the shipped email (sqlite)', () => {
  let linked: Rig
  let unlinked: Rig

  beforeAll(async () => {
    linked = await rig({ storeUrl: STORE_URL })
    unlinked = await rig()
  }, 60_000)

  afterAll(async () => {
    await linked?.close()
    await unlinked?.close()
  })

  // Kills: the handler still only logging; the email to another address; lines, carrier or number missing from the
  // text, or a line naming another line's product or quantity; a link with no key, a key with no row, or a key of
  // another purpose or lifetime (the default 30 days ignoring the store's 7d).
  it('AC-1: with store.url https://shop.test/, a paid guest order of two lines (2 and 3, one with a variant) shipped through POST /api/admin/orders/:id/ship with USPS and a spaced number sends one order-shipped email to the order’s email whose vars carry the number, carrier, tracking number as sent, one itemsList line per order line holding its own name and quantity only, and orderUrl https://shop.test/order/<n>?key=<k>; k opens the order; one new email key row for sha256(k) lives keyLifetime.email; the rendered text names them all and has no {{', async () => {
    const order = await paidOrder(linked, { lines: TWO_LINES })
    await processing(linked, order.orderId)
    const emailKeysBefore = await keyRows(linked, order.orderId, 'email')

    const answer = await ship(linked, order.orderId, 'USPS', USPS_NUMBER)
    await settle(linked)

    expect(answer).toEqual({ status: 200, orderStatus: 'shipped' })
    const mails = shippedTo(linked, order.orderNumber)
    expect(
      mails.map((m) => m.to),
      'order-shipped emails for the order',
    ).toEqual([order.buyer])
    const vars = mails[0]!.vars
    expect([vars['orderNumber'], vars['carrier'], vars['trackingNumber']]).toEqual([
      order.orderNumber,
      'USPS',
      USPS_NUMBER,
    ])

    const items = itemLines(vars)
    expect(items.length, `itemsList lines in ${JSON.stringify(vars['itemsList'])}`).toBe(
      TWO_LINES.length,
    )
    TWO_LINES.forEach((spec, i) => {
      const other = TWO_LINES[1 - i]!
      const held = items[i]!
      expect(
        [
          held.includes(spec.productName),
          holdsNumber(held, spec.qty),
          held.includes(other.productName),
          holdsNumber(held, other.qty),
          spec.variantName === '' || held.includes(spec.variantName),
        ],
        `itemsList line ${i}: "${held}" for ${JSON.stringify(spec)}`,
      ).toEqual([true, true, false, false, true])
    })

    const orderUrl = str(vars['orderUrl'])
    const key = orderUrl === '' ? '' : (new URL(orderUrl).searchParams.get('key') ?? '')
    expect(key, `the key in "${orderUrl}"`).toMatch(ORDER_KEY)
    expect(orderUrl).toBe(
      `https://shop.test/order/${encodeURIComponent(order.orderNumber)}?key=${key}`,
    )

    const res = await fetch(
      new URL(`/api/orders/${encodeURIComponent(order.orderNumber)}`, linked.served.baseUrl),
      { headers: { accept: 'application/json', [ORDER_KEY_HEADER]: key } },
    )
    const body = (await res.json()) as { data?: { orderNumber: string } }
    expect([res.status, body.data?.orderNumber], 'the link’s key reads the order').toEqual([
      200,
      order.orderNumber,
    ])

    expect(await keyRows(linked, order.orderId, 'email'), 'email key rows the ship added').toBe(
      emailKeysBefore + 1,
    )
    const row = await linked.raw.one<{ created_at: string; expires_at: string }>(
      'SELECT created_at, expires_at FROM order_access_keys WHERE order_id = ? AND key_hash = ? AND purpose = ?',
      [order.orderId, sha256(key), 'email'],
    )
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at), 'the key’s lifetime').toBe(
      KEY_LIFETIME_MS,
    )

    const text = renderEmailTemplate(SHIPPED, vars).text
    const missing = [
      order.orderNumber,
      'USPS',
      USPS_NUMBER,
      ...TWO_LINES.map((l) => l.productName),
      orderUrl,
    ].filter((part) => !text.includes(part))
    expect(missing, text).toEqual([])
    expect(text.includes('{{'), text).toBe(false)
  })

  // Kills: a customer's order mailed a URL-borne key, which outlives the session that owns the order.
  it('AC-2: with store.url https://shop.test/, a signed-in customer’s paid order shipped the same way gets orderUrl https://shop.test/account/orders/<n>, its text contains it, and the order has no key row of either purpose', async () => {
    const buyer = `owned-${randomUUID()}@shipped-email.test`
    const { customer } = await linked.k.services.auth.register({
      email: buyer,
      password: 'shipped-email-correct-horse',
    })
    const order = await paidOrder(linked, { customerId: customer.id, buyer })
    await processing(linked, order.orderId)

    const answer = await ship(linked, order.orderId, 'USPS', USPS_NUMBER)
    await settle(linked)

    expect(answer.status).toBe(200)
    const mails = shippedTo(linked, order.orderNumber)
    expect(mails.length, 'order-shipped emails for the order').toBe(1)
    const orderUrl = str(mails[0]!.vars['orderUrl'])
    expect(orderUrl).toBe(
      `https://shop.test/account/orders/${encodeURIComponent(order.orderNumber)}`,
    )
    expect(renderEmailTemplate(SHIPPED, mails[0]!.vars).text).toContain(orderUrl)
    expect(await keyRows(linked, order.orderId), 'key rows for the customer’s order').toBe(0)
  })

  // Kills: a link mailed from a store with no URL; a dangling "View your order:" line; a key minted that no mail
  // carries.
  it('AC-3: with store.url unset, a shipped guest order’s email has no orderUrl and no orderLink, its text has no "View your order" and no /order/, the ship adds no email key row, and the text still names the order, carrier, number and lines', async () => {
    const order = await paidOrder(unlinked, { lines: TWO_LINES })
    await processing(unlinked, order.orderId)
    const emailKeysBefore = await keyRows(unlinked, order.orderId, 'email')

    const answer = await ship(unlinked, order.orderId, 'USPS', USPS_NUMBER)
    await settle(unlinked)

    expect(answer.status).toBe(200)
    const mails = shippedTo(unlinked, order.orderNumber)
    expect(mails.length, 'order-shipped emails for the order').toBe(1)
    const vars = mails[0]!.vars
    const text = renderEmailTemplate(SHIPPED, vars).text
    expect(Object.keys(vars).filter((v) => v === 'orderUrl' || v === 'orderLink')).toEqual([])
    expect([text.includes('View your order'), text.includes('/order/')], text).toEqual([
      false,
      false,
    ])
    expect(await keyRows(unlinked, order.orderId, 'email'), 'email key rows after the ship').toBe(
      emailKeysBefore,
    )
    const missing = [
      order.orderNumber,
      'USPS',
      USPS_NUMBER,
      ...TWO_LINES.map((l) => l.productName),
    ].filter((part) => !text.includes(part))
    expect(missing, text).toEqual([])
  })

  // Kills: the record not written, or keyed so a redelivery sends again; a redelivery minting another key.
  it('AC-4: property: for k = 1-5 deliveries of the same logged order.shipped envelope (the relay’s, then the same envelope handed to the bus again), one order-shipped email, one email key row added by the ship, and one processed record (email:order-shipped, event.id)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (deliveries) => {
        const order = await paidOrder(linked)
        await processing(linked, order.orderId)
        const emailKeysBefore = await keyRows(linked, order.orderId, 'email')

        const answer = await ship(linked, order.orderId, 'UPS', `1Z${randomUUID().slice(0, 12)}`)
        await settle(linked)
        const [event] = await shippedEvents(linked, order.orderId)
        for (let i = 1; i < deliveries; i += 1) await linked.k.eventBus.publish(event!.envelope)
        await settle(linked)

        expect(answer.status).toBe(200)
        expect(
          [
            shippedTo(linked, order.orderNumber).length,
            (await keyRows(linked, order.orderId, 'email')) - emailKeysBefore,
            await processed(linked, SHIPPED_RECORD, event!.id),
          ],
          `[shipped emails, email keys added, records] after ${deliveries} deliveries`,
        ).toEqual([1, 1, 1])
      }),
      { numRuns: 8 },
    )
  }, 120_000)

  // Kills: a second ship publishing a second order.shipped, and so a second email.
  it('AC-4: property: k = 2-5 concurrent POST /api/admin/orders/:id/ship on one processing order answer one 200 and refuse the rest, log one order.shipped and send one order-shipped email', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (k) => {
        const order = await paidOrder(linked)
        await processing(linked, order.orderId)

        const answers = await Promise.all(
          Array.from({ length: k }, (_, i) => ship(linked, order.orderId, 'FedEx', `7712${i}`)),
        )
        await settle(linked)

        const ok = answers.filter((a) => a.status === 200).length
        const refused = answers.filter((a) => a.status >= 400 && a.status < 500).length
        expect(
          [
            ok,
            refused,
            (await shippedEvents(linked, order.orderId)).length,
            shippedTo(linked, order.orderNumber).length,
          ],
          `[200s, refusals, order.shipped events, shipped emails] for ${k} ships: ${JSON.stringify(answers)}`,
        ).toEqual([1, k - 1, 1, 1])
      }),
      { numRuns: 6 },
    )
  }, 120_000)

  // Kills: an unknown carrier sent a link to nowhere, or a dangling tracking line; a known carrier's link dropped.
  it('AC-7: a shipped order with carrier Royal Mail gets trackingUrl equal to trackingUrl("Royal Mail", n) and its text contains it; one with Bob’s Van has neither trackingUrl nor trackingLink, no tracking line without the number and no link but the order’s, and still names Bob’s Van and the number', async () => {
    const { trackingUrl } = await import('../../src/tracking-url.js')
    const royal = await paidOrder(linked)
    const van = await paidOrder(linked)
    await processing(linked, royal.orderId)
    await processing(linked, van.orderId)
    const royalNumber = 'gb 1234 5678 9'
    const vanNumber = 'VAN-0042'

    expect((await ship(linked, royal.orderId, 'Royal Mail', royalNumber)).status).toBe(200)
    expect((await ship(linked, van.orderId, "Bob's Van", vanNumber)).status).toBe(200)
    await settle(linked)

    const [royalMail] = shippedTo(linked, royal.orderNumber)
    const [vanMail] = shippedTo(linked, van.orderNumber)
    expect([royalMail?.to, vanMail?.to], 'order-shipped emails').toEqual([royal.buyer, van.buyer])

    const expectedUrl = trackingUrl('Royal Mail', royalNumber)
    expect(royalMail!.vars['trackingUrl']).toBe(expectedUrl)
    expect(renderEmailTemplate(SHIPPED, royalMail!.vars).text).toContain(expectedUrl)

    const vars = vanMail!.vars
    const text = renderEmailTemplate(SHIPPED, vars).text
    expect(Object.keys(vars).filter((v) => v === 'trackingUrl' || v === 'trackingLink')).toEqual([])
    const trackingLines = text.split('\n').filter((l) => /track/i.test(l))
    expect(
      trackingLines.filter((l) => !l.includes(vanNumber)),
      'tracking lines without the number',
    ).toEqual([])
    expect([...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])).toEqual([str(vars['orderUrl'])])
    expect([text.includes("Bob's Van"), text.includes(vanNumber)], text).toEqual([true, true])
  })

  // Kills: a placeholder address mailed (a bounce against the store's sending reputation); the skip throwing so the
  // relay retries it to dead; the handler logging the address or the number.
  it('AC-8: imported processing orders with emails wc-<id>@unknown.nymbal.local, order-<hash>@imported.nymbal.local and "" shipped through the admin route answer 200 and are shipped; no order-shipped send and no email key row; the event delivered with no counted failure and recorded once; the email handler logs exactly one info line with fields orderId and eventId for it, and none of its lines carries the address or the number', async () => {
    const outcomes: unknown[] = []
    const expected: unknown[] = []
    for (const [label, email] of placeholderAddresses()) {
      const order = await importedOrder(linked, 'processing', email)
      const number = freshNumber()
      const logged = linked.logs.calls.length
      const attempts = linked.attempted.length

      const answer = await ship(linked, order.orderId, 'USPS', number)
      await settle(linked)

      const [event] = await shippedEvents(linked, order.orderId)
      const lines = handlerLines(linked, logged)
      outcomes.push({
        label,
        answer,
        status: await statusOf(linked, order.orderId),
        sends: linked.attempted
          .slice(attempts)
          .filter((m) => m.template === SHIPPED && m.vars['orderNumber'] === order.orderNumber)
          .map((m) => m.to),
        emailKeys: await keyRows(linked, order.orderId, 'email'),
        event: [event!.deliveredAt != null, event!.attempts, event!.deadAt ?? null],
        records: await processed(linked, SHIPPED_RECORD, event!.id),
        lines: linesNaming(lines, [order.orderId, event!.id]),
        leaked: stringsIn(lines.flatMap((c) => [c.obj, c.msg])).filter(
          (s) =>
            s.includes(number) ||
            s.includes(normaliseTrackingNumber(number)) ||
            (email !== '' && s.includes(email)),
        ),
      })
      expected.push({
        label,
        answer: { status: 200, orderStatus: 'shipped' },
        status: 'shipped',
        sends: [],
        emailKeys: 0,
        event: [true, 0, null],
        records: 1,
        lines: [['info', ['eventId', 'orderId'], order.orderId, event!.id]],
        leaked: [],
      })
    }
    expect(outcomes).toEqual(expected)
  }, 60_000)

  // Kills: a real imported customer never told their order shipped (the rule catching every imported order, or every
  // `.local` domain rather than the importer's own `nymbal.local` placeholders).
  it('AC-8: imported processing orders with buyer@example.com and me@shop.local shipped through the admin route each get their order-shipped email', async () => {
    const outcomes: unknown[] = []
    const expected: unknown[] = []
    for (const email of ['buyer@example.com', 'me@shop.local']) {
      const order = await importedOrder(linked, 'processing', email)

      const answer = await ship(linked, order.orderId, 'USPS', freshNumber())
      await settle(linked)

      outcomes.push({
        email,
        answer: answer.status,
        sends: shippedTo(linked, order.orderNumber).map((m) => m.to),
      })
      expected.push({ email, answer: 200, sends: [email] })
    }
    expect(outcomes).toEqual(expected)
  })

  // Kills: an order.shipped for a missing order throwing, so the relay retries it to dead.
  it('AC-8: an order.shipped for an order id that does not exist logs one warn { orderId, eventId } from the email handler, sends nothing, and is delivered and recorded', async () => {
    const orderId = uuidv7()
    const seq = await maxSeq(linked.raw)
    const logged = linked.logs.calls.length
    const attempts = linked.attempted.length

    await unaudited(() =>
      linked.k.publisher.publish(EVT_ORDER_SHIPPED, {
        orderId,
        trackingNumber: 'GHOST123',
        carrier: 'USPS',
      }),
    )
    await settle(linked)

    const [event] = (
      await eventRows(linked.raw, 'seq > ? AND type = ?', [seq, EVT_ORDER_SHIPPED])
    ).filter((e) => (e.envelope.payload as { orderId?: string }).orderId === orderId)
    const warns = handlerLines(linked, logged)
      .filter((c) => c.level === 'warn')
      .map((c) => c.obj)
    expect(warns).toEqual([{ orderId, eventId: event!.id }])
    expect(linked.attempted.slice(attempts).filter((m) => m.template === SHIPPED)).toEqual([])
    expect([event!.deliveredAt != null, event!.deadAt ?? null]).toEqual([true, null])
    expect(await processed(linked, SHIPPED_RECORD, event!.id)).toBe(1)
  })

  // Kills: a failed send swallowed, so the shopper never gets the email; a send failure moving or refusing the ship.
  it('AC-9: property: with sendTransactional throwing on the first n = 1-3 order-shipped sends, the ship answers 200 and the order stays shipped; once the relay has retried, exactly one order-shipped send was accepted and the event is delivered, not dead', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (n) => {
        const order = await paidOrder(linked)
        await processing(linked, order.orderId)
        linked.failShipped.left = n
        try {
          const answer = await ship(linked, order.orderId, 'DHL', `JD${randomUUID().slice(0, 10)}`)
          const afterShip = await statusOf(linked, order.orderId)
          await settle(linked)

          const [event] = await shippedEvents(linked, order.orderId)
          expect(
            [
              answer,
              afterShip,
              await statusOf(linked, order.orderId),
              shippedTo(linked, order.orderNumber).length,
              event?.deliveredAt != null,
              event?.deadAt ?? null,
            ],
            `[answer, status after the ship, status after the retries, accepted shipped sends, delivered, dead] with ${n} failures`,
          ).toEqual([{ status: 200, orderStatus: 'shipped' }, 'shipped', 'shipped', 1, true, null])
        } finally {
          linked.failShipped.left = 0
        }
      }),
      { numRuns: 5 },
    )
  }, 120_000)

  // Kills: the fallback in one email only, or in the renderer and not the vars; whitespace-only names greeting
  // "Hi   ,"; padded names keeping their padding; a resend or link request greeting differently from order.paid.
  it('AC-11: property: over billing first names "", whitespace-only, padded and plain, the customerName of the shipped email and of the placed email on order.paid, its resend and requestLink is the trimmed name or "there", and each rendered text starts "Hi <that>,"', async () => {
    const firstName = fc.oneof(
      fc.constant(''),
      fc.stringMatching(/^[ \t]{1,6}$/),
      fc
        .tuple(
          fc.stringMatching(/^[ \t]{0,3}$/),
          fc.stringMatching(/^[A-Z][a-z]{1,8}$/),
          fc.stringMatching(/^[ \t]{0,3}$/),
        )
        .map(([before, name, after]) => `${before}${name}${after}`),
      fc.constant('  Ada '),
    )
    await fc.assert(
      fc.asyncProperty(firstName, async (name) => {
        const expected = name.trim() === '' ? 'there' : name.trim()
        const order = await paidOrder(linked, { firstName: name })
        const placedOnPaid = placedFor(linked, order.orderNumber).length

        await linked.k.services.order.resendConfirmation(order.orderId)
        await settle(linked)
        await linked.k.services.order.requestLink(order.orderNumber, order.buyer)
        await settle(linked)
        await processing(linked, order.orderId)
        await ship(linked, order.orderId, 'USPS', `9400${randomUUID().slice(0, 8)}`)
        await settle(linked)

        const greeting = (m: TransactionalEmail) => [
          m.vars['customerName'],
          renderEmailTemplate(m.template, m.vars).text.startsWith(`Hi ${expected},`),
        ]
        const placed = placedFor(linked, order.orderNumber)
        expect(
          [placedOnPaid, placed.map(greeting)],
          `the placed emails (order.paid, resend, requestLink) for first name ${JSON.stringify(name)}`,
        ).toEqual([1, [PLACED, PLACED, PLACED].map(() => [expected, true])])
        expect(
          shippedTo(linked, order.orderNumber).map(greeting),
          `the shipped email for first name ${JSON.stringify(name)}`,
        ).toEqual([[expected, true]])
      }),
      { numRuns: 10 },
    )
  }, 180_000)

  // Kills: a resend for an imported order mailing the importer's placeholder; the skip throwing so the relay retries
  // it; the real-address resend skipped too.
  it('AC-12: imported confirmed orders with order-<hash>@imported.nymbal.local and "" get no order-placed email and no email key row from POST /api/admin/orders/:id/resend-confirmation or requestLink(<number>, <that email>); each skipped send is one email-handler info line with orderId and eventId only, none carrying the address; the events are delivered, not retried; imported confirmed orders with buyer@example.com and me@shop.local still get their resend', async () => {
    const outcomes: unknown[] = []
    const expected: unknown[] = []
    const addresses = placeholderAddresses().slice(1)
    for (const [label, email] of addresses) {
      const order = await importedOrder(linked, 'confirmed', email)
      const seq = await maxSeq(linked.raw)
      const logged = linked.logs.calls.length
      const attempts = linked.attempted.length

      const answer = await linked.admin.send(
        'POST',
        `/api/admin/orders/${encodeURIComponent(order.orderId)}/resend-confirmation`,
        undefined,
        { [IDEMPOTENCY_KEY]: `resend.${randomUUID()}` },
      )
      await settle(linked)
      await linked.k.services.order.requestLink(order.orderNumber, email)
      await settle(linked)

      const events = (
        await eventRows(linked.raw, 'seq > ? AND type = ?', [
          seq,
          EVT_ORDER_CONFIRMATION_RESEND_REQUESTED,
        ])
      ).filter((e) => (e.envelope.payload as { orderId?: string }).orderId === order.orderId)
      const lines = handlerLines(linked, logged)
      outcomes.push({
        label,
        answer: answer.status,
        sends: linked.attempted
          .slice(attempts)
          .filter((m) => m.template === PLACED && m.vars['orderNumber'] === order.orderNumber)
          .map((m) => m.to),
        emailKeys: await keyRows(linked, order.orderId, 'email'),
        events: events.map((e) => [e.deliveredAt != null, e.attempts, e.deadAt ?? null]),
        lines: linesNaming(lines, [order.orderId, ...events.map((e) => e.id)]),
        leaked:
          email === ''
            ? []
            : stringsIn(lines.flatMap((c) => [c.obj, c.msg])).filter((s) => s.includes(email)),
      })
      expected.push({
        label,
        answer: 200,
        sends: [],
        emailKeys: 0,
        events: [
          [true, 0, null],
          [true, 0, null],
        ],
        lines: events.map((e) => ['info', ['eventId', 'orderId'], order.orderId, e.id]),
        leaked: [],
      })
    }

    for (const email of ['buyer@example.com', 'me@shop.local']) {
      const real = await importedOrder(linked, 'confirmed', email)
      const resent = await linked.admin.send(
        'POST',
        `/api/admin/orders/${encodeURIComponent(real.orderId)}/resend-confirmation`,
        undefined,
        { [IDEMPOTENCY_KEY]: `resend.${randomUUID()}` },
      )
      await settle(linked)
      outcomes.push({
        label: email,
        answer: resent.status,
        sends: placedFor(linked, real.orderNumber).map((m) => m.to),
      })
      expected.push({ label: email, answer: 200, sends: [email] })
    }

    expect(outcomes).toEqual(expected)
  }, 60_000)
})
