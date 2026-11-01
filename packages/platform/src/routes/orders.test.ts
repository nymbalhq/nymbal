import fc from 'fast-check'
import { describe, it, expect } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { buildOrderDoc, type OrderDoc } from '../read-models/builders.js'
import { registerOrderRoutes } from './orders.js'
import {
  documentValueAt,
  type Address,
  type HttpAdapter,
  type Order,
  type OrderHistoryEntry,
  type OrderStatus,
  type ResponseEnvelope,
  type RouteHandler,
  type RequestContext,
} from '@nymbalhq/types'
import type { OrderService } from '../services/order-service.js'
import {
  addKey,
  headerOf,
  ORDER_KEY_HEADER,
  orderRig,
  placeOrder,
  wire,
} from '../tests/order-routes.js'

// Each property drives the routes dozens of times; a loaded CI runner took 9 s where a laptop takes 0.3 s.
const PROPERTY_TIMEOUT_MS = 30_000

function makeAdapter() {
  const routes = new Map<string, RouteHandler>()
  const adapter: HttpAdapter = {
    registerRoute(method, path, handler) {
      routes.set(`${method}:${path}`, handler)
    },
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }

  async function invoke(
    method: string,
    path: string,
    options: {
      params?: Record<string, string>
      auth?: RequestContext['auth']
      headers?: Record<string, string>
    } = {},
  ) {
    const handler = routes.get(`${method}:${path}`)
    if (!handler) throw new Error(`No route registered for ${method} ${path}`)
    return handler({
      method: method as 'GET',
      path,
      url: `http://localhost${path}`,
      params: options.params ?? {},
      query: {},
      body: null,
      headers: options.headers ?? {},
      cookies: {},
      ...(options.auth !== undefined && { auth: options.auth }),
      requestId: 'test-req',
      correlationId: 'test-corr',
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this
        },
      },
      ip: '127.0.0.1',
    })
  }

  return { adapter, invoke }
}

/** The keys that open each order, by order id: `keyOpens` answers true for those and nothing else. */
function makeOrderService(
  opens: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): OrderService {
  const access: Pick<OrderService, 'keyOpens'> = {
    async keyOpens(orderId: string, key: string) {
      return opens.get(orderId)?.has(key) ?? false
    },
  }
  return access as unknown as OrderService
}

describe('GET /api/orders', () => {
  it('returns 401 when user is not authenticated', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders')
    expect(resp.status).toBe(401)
  })

  it('lists exactly the signed-in customer’s orders, none of another’s, over generated orders across three customers', async () => {
    const customers = ['cust-1', 'cust-2', 'cust-3']
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...customers), { maxLength: 10 }),
        async (owners) => {
          const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
          for (const [i, customerId] of owners.entries()) {
            const orderNumber = `NYM-${String(i).padStart(3, '0')}`
            await documentStore.put('orders-by-customer', `customer:${customerId}#${orderNumber}`, {
              partitionKey: `customer:${customerId}`,
              sortKey: orderNumber,
              orderNumber,
              customerId,
              totalMinor: 1000 * (i + 1),
              currency: 'GBP',
            })
          }
          const { adapter, invoke } = makeAdapter()
          registerOrderRoutes(adapter, makeOrderService(), documentStore)

          for (const customerId of customers) {
            const resp = await invoke('GET', '/api/orders', {
              auth: { userId: customerId, roles: ['customer'] },
            })
            expect(resp.status).toBe(200)
            const listed = (resp.body as { data: Array<{ orderNumber: string }> }).data
            const theirs = owners.flatMap((owner, i) =>
              owner === customerId ? [`NYM-${String(i).padStart(3, '0')}`] : [],
            )
            expect(listed.map((o) => o.orderNumber).sort(), customerId).toEqual(theirs.sort())
          }
        },
      ),
      { numRuns: 25 },
    )
  })
})

describe('GET /api/orders/:orderNumber', () => {
  it('returns 404 when order does not exist', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-MISSING' },
    })
    expect(resp.status).toBe(404)
  })

  it('allows authenticated user to access their own order', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders', 'NYM-003', {
      orderNumber: 'NYM-003',
      customerId: 'cust-1',
      totalMinor: 4500,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-003' },
      auth: { userId: 'cust-1', roles: ['customer'] },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { orderNumber: string } }
    expect(body.data.orderNumber).toBe('NYM-003')
  })
})

const STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
]
/** Paths a shopper's order never carries: checkout's cart and stock bookkeeping, import provenance, store keys, the status history. */
const INTERNAL_PATHS = [
  'metadata.cartToken',
  'metadata.reservationIds',
  'metadata.correlationId',
  'metadata.woocommerce',
  'partitionKey',
  'sortKey',
  'history',
] as const

/** What a key holder never receives: the customer's contact and billing details, internal ids and the money trail. */
const KEYED_ABSENT = [
  'billingAddress',
  'customerId',
  'sequence',
  'capturedAt',
  'captureMethod',
  'refundedMinor',
  'email',
] as const
/** What an owner's own read drops: the internal ids and how the payment was captured. */
const OWNER_ABSENT = ['customerId', 'sequence', 'capturedAt', 'captureMethod'] as const

/** Every order field the keyed confirmation page of either template renders. */
const KEYED_READ = [
  'orderNumber',
  'status',
  'timeline',
  'createdAt',
  'currency',
  'lineItems',
  'subtotalMinor',
  'taxTotalMinor',
  'shippingTotalMinor',
  'discountTotalMinor',
  'totalMinor',
] as const
/** Every order field either template's account order pages render. */
const OWNER_READ = [...KEYED_READ, 'id', 'email', 'billingAddress', 'shippingAddress'] as const

const CREATED = '2026-10-01T09:00:00.000Z'
const HOUR = 3_600_000

const address = fc.record({
  firstName: fc.constantFrom('Ada', 'Grace'),
  lastName: fc.constantFrom('Buyer', 'Hopper'),
  line: fc.uuid(),
  phone: fc.option(fc.uuid(), { nil: undefined }),
  company: fc.option(fc.uuid(), { nil: undefined }),
})

const placed = fc.record({
  id: fc.uuid(),
  owner: fc.constantFrom(null, 'cust-1', 'cust-2'),
  status: fc.constantFrom(...STATUSES),
  cart: fc.uuid(),
  reservations: fc.array(fc.uuid(), { minLength: 1, maxLength: 3 }),
  correlation: fc.option(fc.uuid(), { nil: undefined }),
  imported: fc.boolean(),
  intent: fc.option(fc.uuid(), { nil: null }),
  staff: fc.uuid(),
  staffNote: fc.uuid(),
  reason: fc.uuid(),
  totalMinor: fc.integer({ min: 1, max: 100_000 }),
  billing: address,
  shipping: address,
})

type Placed = typeof placed extends fc.Arbitrary<infer T> ? T : never
type Generated = typeof address extends fc.Arbitrary<infer T> ? T : never

function addressOf(a: Generated, tag: string): Address {
  return {
    firstName: a.firstName,
    lastName: a.lastName,
    addressLine1: `${tag}-line-${a.line}`,
    city: 'London',
    region: 'England',
    postalCode: 'E1 6AN',
    country: 'GB',
    ...(a.phone !== undefined && { phone: `${tag}-phone-${a.phone}` }),
    ...(a.company !== undefined && { company: `${tag}-company-${a.company}` }),
  }
}

/**
 * The order as checkout and the admin leave it, and the values in it a key holder must not see (internal ones,
 * prefixed so no two collide, and the customer's contact details).
 */
function orderOf(
  p: Placed,
  i: number,
): { order: Order; history: OrderHistoryEntry[]; secrets: string[]; private: string[] } {
  const orderNumber = `NYM-${String(i).padStart(4, '0')}`
  const paid = p.status !== 'pending' && p.status !== 'cancelled'
  const cartToken = `cart-${p.cart}`
  const reservationIds = p.reservations.map((r) => `res-${r}`)
  const correlationId = p.correlation === undefined ? undefined : `corr-${p.correlation}`
  const paymentIntentId = p.intent === null ? null : `pi_${p.intent}`
  const staff = `admin:${p.staff}`
  const staffNote = `note-${p.staffNote}`
  const reason = `reason-${p.reason}`
  const billingAddress = addressOf(p.billing, `bill-${i}`)
  const shippingAddress = addressOf(p.shipping, `ship-${i}`)
  const email = `shopper-${i}-${p.id.slice(0, 8)}@orders.test`
  const order: Order = {
    id: p.id,
    orderNumber,
    sequence: 1000 + i,
    customerId: p.owner,
    status: p.status,
    email,
    billingAddress,
    shippingAddress,
    lineItems: [
      {
        variantId: 'v-1',
        productId: 'p-1',
        productName: 'Widget',
        variantName: 'Default',
        sku: 'W-1',
        qty: 1,
        unitPriceMinor: p.totalMinor,
        lineSubtotalMinor: p.totalMinor,
        lineTaxMinor: 0,
        lineTotalMinor: p.totalMinor,
        imageUrl: '',
      },
    ],
    subtotalMinor: p.totalMinor,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: p.totalMinor,
    currency: 'GBP',
    notes: JSON.stringify([{ body: staffNote, actor: staff, at: CREATED }]),
    metadata: {
      cartToken,
      reservationIds,
      ...(correlationId !== undefined && { correlationId }),
      ...(p.imported && { woocommerce: { orderId: 41, paymentMethod: 'cod' } }),
    },
    paymentIntentId,
    capturedMinor: paid ? p.totalMinor : 0,
    capturedAt: paid ? CREATED : null,
    refundedMinor: 0,
    captureMethod: paid ? 'provider' : null,
    createdAt: CREATED,
    updatedAt: CREATED,
  }
  const history: OrderHistoryEntry[] = [
    {
      id: `h-${i}-0`,
      orderId: p.id,
      fromStatus: null,
      toStatus: 'pending',
      actor: 'system:checkout',
      note: 'order draft created',
      timestamp: CREATED,
    },
    ...(p.status === 'pending'
      ? []
      : [
          {
            id: `h-${i}-1`,
            orderId: p.id,
            fromStatus: 'pending' as const,
            toStatus: p.status,
            actor: staff,
            note: reason,
            timestamp: CREATED,
          },
        ]),
  ]
  const secrets = [cartToken, ...reservationIds, staff, staffNote]
  if (p.status !== 'pending') secrets.push(reason)
  if (correlationId !== undefined) secrets.push(correlationId)
  if (paymentIntentId !== null) secrets.push(paymentIntentId)
  // A key holder sees the shipping name and lines, and none of these.
  const contact = [
    email,
    billingAddress.addressLine1,
    ...[
      billingAddress.phone,
      billingAddress.company,
      shippingAddress.phone,
      shippingAddress.company,
    ].filter((v): v is string => v !== undefined),
    ...(p.owner === null ? [] : [p.owner]),
  ]
  return { order, history, secrets, private: contact }
}

/** The shipping address a key holder reads: the order's, without its phone and company. */
function keyedShipping(a: Address): Address {
  const { phone: _phone, company: _company, ...rest } = a
  return rest
}

/** The read as a JSON client receives it, `undefined` fields gone. */
const received = (resp: ResponseEnvelope) =>
  JSON.parse(JSON.stringify(resp.body)) as { data: Record<string, unknown> }

const orderKey = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)
/** Values that are not an order key: empty, one character short or long, a character outside base64url, prose. */
const MALFORMED_KEYS = ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, 'not a key']

interface Caller {
  label: string
  auth?: RequestContext['auth']
  headers?: Record<string, string>
}

describe('AC-1: an order is read with a key that opens it or by its owner, and is not found for anyone else', () => {
  // Kills: a key that opens another order; a session that opens a guest order or another customer's; a 403 or a
  // different body that says the order exists; a shared cache keeping an answer; a key holder served the owner's view.
  it('AC-1: property: over generated guest and owned orders with unexpired keys, GET /api/orders/:orderNumber answers 200 with the order to a key that opens it (with or without a session) and to its owner’s session; no header, a malformed, empty or wrong key, another order’s key, a non-owner’s session, any session on a guest order and an admin session each get 404 with the body of a number no order has; every answer is Cache-Control: no-store; every key holder reads the same view, and the owner reads theirs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(placed, { minLength: 2, maxLength: 4, selector: (p) => p.id }),
        fc.uniqueArray(orderKey, { minLength: 9, maxLength: 9 }),
        fc.boolean(),
        async (placements, keys, twoKeys) => {
          const rig = await orderRig()
          try {
            const orders: OrderDoc[] = []
            for (const [i, p] of placements.entries()) {
              const { order, history } = orderOf(p, i)
              orders.push(await placeOrder(rig, order, history))
            }
            // Order i opens with keys[2i] (and keys[2i + 1] when it has two); keys[8] opens nothing.
            const keysOf = orders.map((_, i) =>
              twoKeys ? [keys[2 * i]!, keys[2 * i + 1]!] : [keys[2 * i]!],
            )
            for (const [i, doc] of orders.entries()) {
              for (const key of keysOf[i]!)
                addKey(rig, doc.id, key, { expiresAt: new Date(Date.now() + 24 * HOUR) })
            }
            const strangerKey = keys[8]!

            const read = (orderNumber: string, caller: Caller, via = rig.invoke) =>
              via('GET', '/api/orders/:orderNumber', {
                params: { orderNumber },
                ...(caller.auth !== undefined && { auth: caller.auth }),
                ...(caller.headers !== undefined && { headers: caller.headers }),
              })
            const withKey = (key: string) => ({ [ORDER_KEY_HEADER]: key })
            const admin = { userId: 'admin-1', roles: ['admin'] }
            const nonOwner = { userId: 'cust-3', roles: ['customer'] }

            for (const [i, doc] of orders.entries()) {
              const n = doc.orderNumber
              const owner = doc.customerId
              const own = keysOf[i]!
              const otherKeys = keysOf.filter((_, j) => j !== i).flat()

              const denied: Caller[] = [
                { label: 'no credential' },
                ...MALFORMED_KEYS.map((key) => ({
                  label: `the malformed key "${key}"`,
                  headers: withKey(key),
                })),
                { label: 'a key no order has', headers: withKey(strangerKey) },
                ...otherKeys.map((key) => ({
                  label: 'another order’s key',
                  headers: withKey(key),
                })),
                owner === null
                  ? {
                      label: 'a session on a guest order',
                      auth: { userId: 'cust-1', roles: ['customer'] },
                    }
                  : { label: 'a signed-in non-owner', auth: nonOwner },
                { label: 'an admin session', auth: admin },
              ]
              const keyed: Caller[] = [
                ...own.map((key) => ({ label: 'its key', headers: withKey(key) })),
                ...own.map((key) => ({
                  label: 'its key with a stranger’s session',
                  headers: withKey(key),
                  auth: nonOwner,
                })),
                { label: 'its key with an admin session', headers: withKey(own[0]!), auth: admin },
              ]

              const unknown = await read(n, { label: 'nobody' }, rig.nothing)
              expect(unknown.status, `${n}: a number no order has`).toBe(404)
              expect(headerOf(unknown, 'cache-control'), `${n}: no order`).toBe('no-store')

              for (const caller of denied) {
                const resp = await read(n, caller)
                const label = `${n} (${owner ?? 'guest'}) read by ${caller.label}`
                expect(resp.status, label).toBe(404)
                expect(wire(resp), label).toBe(wire(unknown))
                expect(headerOf(resp, 'cache-control'), label).toBe('no-store')
              }

              const answers: string[] = []
              for (const caller of keyed) {
                const resp = await read(n, caller)
                const label = `${n} (${owner ?? 'guest'}) read by ${caller.label}`
                expect(resp.status, label).toBe(200)
                expect(headerOf(resp, 'cache-control'), label).toBe('no-store')
                expect(received(resp).data['orderNumber'], label).toBe(n)
                answers.push(wire(resp))
              }
              // Whoever a key lets in reads the same view of the order.
              for (const body of answers) expect(body, `${n}: key holders`).toBe(answers[0])

              const owners: Caller[] =
                owner === null
                  ? []
                  : [{ label: 'its owner', auth: { userId: owner, roles: ['customer'] } }]
              for (const caller of owners) {
                const resp = await read(n, caller)
                expect(resp.status, `${n} read by its owner`).toBe(200)
                expect(headerOf(resp, 'cache-control'), `${n} read by its owner`).toBe('no-store')
                expect(received(resp).data['id'], `${n} read by its owner`).toBe(doc.id)
              }
            }
          } finally {
            await rig.close()
          }
        },
      ),
      { numRuns: 30 },
    )
  }, PROPERTY_TIMEOUT_MS)
})

describe('shopper order responses', () => {
  // Kills: the keyed read spreading the stored order (`shopperOrder`), so a key holder gets the customer's phones,
  // billing address, email or an internal id; an owner's read losing an address or the email the account pages show,
  // or still carrying the internal ids.
  it('AC-4: property: over generated orders, guest or customer, pending or paid, with phones and companies on their addresses, a read opened by the order’s key carries none of billingAddress, customerId, sequence, capturedAt, captureMethod, refundedMinor or email, a shippingAddress equal to the order’s without phone and company, every field the keyed pages render equal to the order’s, and none of the customer’s contact values or internal values anywhere; the owner’s read and GET /api/orders carry both addresses and the email equal to the order’s, every field the account pages render, and none of customerId, sequence, capturedAt, captureMethod or an internal value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(placed, { minLength: 1, maxLength: 5, selector: (p) => p.id }),
        fc.uniqueArray(orderKey, { minLength: 5, maxLength: 5 }),
        async (placements, keys) => {
          const rig = await orderRig()
          try {
            const orders = placements.map(orderOf)
            for (const [i, o] of orders.entries()) {
              await placeOrder(rig, o.order, o.history)
              addKey(rig, o.order.id, keys[i]!, { expiresAt: new Date(Date.now() + 24 * HOUR) })
            }
            const secrets = orders.flatMap((o) => o.secrets)

            for (const [i, o] of orders.entries()) {
              const source = o.order
              const label = `${source.orderNumber} (${source.customerId ?? 'guest'}) with its key`
              const resp = await rig.invoke('GET', '/api/orders/:orderNumber', {
                params: { orderNumber: source.orderNumber },
                headers: { [ORDER_KEY_HEADER]: keys[i]! },
              })
              expect(resp.status, label).toBe(200)
              const view = received(resp).data
              expect(
                KEYED_ABSENT.filter((f) => Object.hasOwn(view, f)),
                `${label}: fields a key holder never receives`,
              ).toEqual([])
              expect(view['shippingAddress'], `${label}: shippingAddress`).toEqual(
                keyedShipping(source.shippingAddress),
              )
              for (const field of KEYED_READ) {
                const expected =
                  field === 'timeline' ? buildOrderDoc(source, o.history).timeline : source[field]
                expect(view[field], `${label}: ${field}`).toEqual(expected)
              }
              const text = wire(resp)
              for (const value of [...o.private, ...secrets])
                expect(text.includes(value), `${label} carries ${value}`).toBe(false)
              for (const path of INTERNAL_PATHS)
                expect(documentValueAt(view, path), `${label}: ${path}`).toBeUndefined()
            }

            const ownerReads: Array<{
              label: string
              view: Record<string, unknown>
              text: string
            }> = []
            for (const o of orders.filter((x) => x.order.customerId !== null)) {
              const resp = await rig.invoke('GET', '/api/orders/:orderNumber', {
                params: { orderNumber: o.order.orderNumber },
                auth: { userId: o.order.customerId!, roles: ['customer'] },
              })
              expect(resp.status, `${o.order.orderNumber} as its owner`).toBe(200)
              ownerReads.push({
                label: `${o.order.orderNumber} as its owner`,
                view: received(resp).data,
                text: wire(resp),
              })
            }
            for (const customerId of ['cust-1', 'cust-2']) {
              const resp = await rig.invoke('GET', '/api/orders', {
                auth: { userId: customerId, roles: ['customer'] },
              })
              expect(resp.status, customerId).toBe(200)
              const listed = (received(resp) as unknown as { data: Array<Record<string, unknown>> })
                .data
              expect(listed.length, customerId).toBe(
                orders.filter((o) => o.order.customerId === customerId).length,
              )
              for (const view of listed)
                ownerReads.push({
                  label: `GET /api/orders as ${customerId}`,
                  view,
                  text: wire(resp),
                })
            }
            for (const { label, view, text } of ownerReads) {
              const o = orders.find((x) => x.order.orderNumber === view['orderNumber'])!
              expect(
                OWNER_ABSENT.filter((f) => Object.hasOwn(view, f)),
                `${label}: fields an owner’s read drops`,
              ).toEqual([])
              for (const field of OWNER_READ) {
                const expected =
                  field === 'timeline' ? buildOrderDoc(o.order, o.history).timeline : o.order[field]
                expect(view[field], `${label}: ${field}`).toEqual(expected)
              }
              for (const secret of secrets)
                expect(text.includes(secret), `${label} carries ${secret}`).toBe(false)
              for (const path of INTERNAL_PATHS)
                expect(documentValueAt(view, path), `${label}: ${path}`).toBeUndefined()
            }

            // The stored document keeps everything: the admin reads it in full.
            for (const { order } of orders) {
              const stored = await rig.documentStore.get<OrderDoc>('orders', order.orderNumber)
              expect(stored?.metadata.cartToken).toBe(order.metadata.cartToken)
              expect(stored?.billingAddress).toEqual(order.billingAddress)
            }
          } finally {
            await rig.close()
          }
        },
      ),
      { numRuns: 25 },
    )
  }, PROPERTY_TIMEOUT_MS)
})
