import fc from 'fast-check'
import { describe, it, expect } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { buildOrderDoc, orderWrites, type OrderDoc } from '../read-models/builders.js'
import { registerOrderRoutes } from './orders.js'
import {
  documentValueAt,
  type HttpAdapter,
  type Order,
  type OrderHistoryEntry,
  type OrderStatus,
  type RouteHandler,
  type RequestContext,
} from '@nymbalhq/types'
import type { OrderService } from '../services/order-service.js'

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
      headers: {},
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

function makeOrderService(): OrderService {
  return {} as unknown as OrderService
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

  it('returns order document when it exists', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders', 'NYM-001', {
      orderNumber: 'NYM-001',
      customerId: null,
      totalMinor: 2000,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-001' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { orderNumber: string; totalMinor: number } }
    expect(body.data.orderNumber).toBe('NYM-001')
    expect(body.data.totalMinor).toBe(2000)
  })

  it('returns 403 when authenticated user tries to access another customers order', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders', 'NYM-002', {
      orderNumber: 'NYM-002',
      customerId: 'cust-2',
      totalMinor: 3000,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-002' },
      auth: { userId: 'cust-1', roles: ['customer'] },
    })
    expect(resp.status).toBe(403)
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

  it('allows unauthenticated access for guest orders (no customerId)', async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    await documentStore.put('orders', 'NYM-004', {
      orderNumber: 'NYM-004',
      customerId: null,
      totalMinor: 1500,
      currency: 'GBP',
    })

    const { adapter, invoke } = makeAdapter()
    registerOrderRoutes(adapter, makeOrderService(), documentStore)

    const resp = await invoke('GET', '/api/orders/:orderNumber', {
      params: { orderNumber: 'NYM-004' },
    })
    expect(resp.status).toBe(200)
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
/** Paths a shopper's order never carries: cart and stock bookkeeping, import provenance, store keys, status history. */
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

/** Every order field the storefront templates and elements read. */
const READ_FIELDS = [
  'id',
  'orderNumber',
  'status',
  'email',
  'createdAt',
  'currency',
  'lineItems',
  'billingAddress',
  'shippingAddress',
  'subtotalMinor',
  'taxTotalMinor',
  'shippingTotalMinor',
  'discountTotalMinor',
  'totalMinor',
] as const

const CREATED = '2026-10-01T09:00:00.000Z'
const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

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
})

type Placed = typeof placed extends fc.Arbitrary<infer T> ? T : never

/** The order as checkout and the admin leave it, and the internal values in it, each prefixed so no two collide. */
function orderOf(p: Placed, i: number): { doc: OrderDoc; secrets: string[] } {
  const orderNumber = `NYM-${String(i).padStart(4, '0')}`
  const paid = p.status !== 'pending' && p.status !== 'cancelled'
  const cartToken = `cart-${p.cart}`
  const reservationIds = p.reservations.map((r) => `res-${r}`)
  const correlationId = p.correlation === undefined ? undefined : `corr-${p.correlation}`
  const paymentIntentId = p.intent === null ? null : `pi_${p.intent}`
  const staff = `admin:${p.staff}`
  const staffNote = `note-${p.staffNote}`
  const reason = `reason-${p.reason}`
  const order: Order = {
    id: p.id,
    orderNumber,
    sequence: i,
    customerId: p.owner,
    status: p.status,
    email: `shopper-${i}@orders.test`,
    billingAddress: ADDRESS,
    shippingAddress: ADDRESS,
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
  return { doc: buildOrderDoc(order, history), secrets }
}

describe('shopper order responses', () => {
  it('serve no internal field of any order, guest or customer, pending or paid, from GET /api/orders/:orderNumber or GET /api/orders, and every field the storefront reads unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(placed, { minLength: 1, maxLength: 6 }), async (placements) => {
        const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
        const orders = placements.map(orderOf)
        for (const { doc } of orders) {
          for (const w of orderWrites(doc)) await documentStore.put(w.collection, w.key, w.doc)
        }
        const { adapter, invoke } = makeAdapter()
        registerOrderRoutes(adapter, makeOrderService(), documentStore)

        const served: Array<{ label: string; body: unknown; order: unknown }> = []
        for (const { doc } of orders) {
          const owner = doc.customerId
          const reads = [
            { label: `${doc.orderNumber} anonymously`, auth: undefined },
            ...(owner === null
              ? []
              : [
                  {
                    label: `${doc.orderNumber} as ${owner}`,
                    auth: { userId: owner, roles: ['customer'] },
                  },
                ]),
          ]
          for (const { label, auth } of reads) {
            const resp = await invoke('GET', '/api/orders/:orderNumber', {
              params: { orderNumber: doc.orderNumber },
              ...(auth !== undefined && { auth }),
            })
            expect(resp.status, label).toBe(200)
            served.push({ label, body: resp.body, order: (resp.body as { data: unknown }).data })
          }
        }
        for (const customerId of ['cust-1', 'cust-2']) {
          const resp = await invoke('GET', '/api/orders', {
            auth: { userId: customerId, roles: ['customer'] },
          })
          expect(resp.status, customerId).toBe(200)
          const listed = (resp.body as { data: unknown[] }).data
          expect(listed.length, customerId).toBe(
            orders.filter((o) => o.doc.customerId === customerId).length,
          )
          for (const order of listed)
            served.push({ label: `GET /api/orders as ${customerId}`, body: resp.body, order })
        }

        const secrets = orders.flatMap((o) => o.secrets)
        for (const { label, body, order } of served) {
          const text = JSON.stringify(body)
          for (const secret of secrets)
            expect(text.includes(secret), `${label} carries ${secret}`).toBe(false)
          for (const path of INTERNAL_PATHS)
            expect(documentValueAt(order, path), `${label}: ${path}`).toBeUndefined()
          const o = order as OrderDoc
          const source = orders.find((x) => x.doc.orderNumber === o.orderNumber)!.doc
          for (const field of READ_FIELDS)
            expect(o[field], `${label}: ${field}`).toEqual(source[field])
          expect(o.timeline, label).toEqual(source.timeline)
        }

        // The stored document keeps everything: the admin reads it in full.
        for (const { doc } of orders) {
          const stored = await documentStore.get<OrderDoc>('orders', doc.orderNumber)
          expect(stored?.metadata.cartToken).toBe(doc.metadata.cartToken)
        }
      }),
      { numRuns: 25 },
    )
  })
})
