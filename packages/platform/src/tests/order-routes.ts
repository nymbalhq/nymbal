import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type {
  HttpAdapter,
  Order,
  OrderHistoryEntry,
  RequestContext,
  ResponseEnvelope,
  RouteHandler,
} from '@nymbalhq/types'
import { createCommandStore, rawClients, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildOrderDoc, orderWrites, type OrderDoc } from '../read-models/builders.js'
import { buildRepositories, type Repositories } from '../repositories/index.js'
import { registerOrderRoutes } from '../routes/orders.js'
import { createOrderService } from '../services/order-service.js'
import { wirePublisher } from './publisher.js'

// The shopper order routes over the real order service on a SQLite `:memory:` command store, so what opens an order is
// what the store's key rows say. An order is written twice, as the kernel holds it: its row in the command store and
// its document in the read side. A key row is written as the table holds one (the sha256 hex of the key, its purpose,
// `created_at` and `expires_at` as ISO UTC text), so a test chooses a key's expiry without a clock.

export const ORDER_KEY_HEADER = 'x-nymbal-order-key'
export const ORDER_EMAIL_HEADER = 'x-nymbal-order-email'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export interface Invoke {
  (
    method: string,
    path: string,
    options?: {
      params?: Record<string, string>
      auth?: RequestContext['auth']
      headers?: Record<string, string>
      body?: unknown
    },
  ): Promise<ResponseEnvelope>
}

/** An adapter that only records routes, and a way to call one as the HTTP adapter would. */
export function makeAdapter(): { adapter: HttpAdapter; invoke: Invoke } {
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
  const invoke: Invoke = async (method, path, options = {}) => {
    const handler = routes.get(`${method}:${path}`)
    if (!handler) throw new Error(`No route registered for ${method} ${path}`)
    return handler({
      method: method as 'GET',
      path,
      url: `http://localhost${path}`,
      params: options.params ?? {},
      query: {},
      body: options.body ?? null,
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

export interface OrderRig {
  store: CommandStore
  repos: Repositories
  documentStore: InMemoryDocumentStore
  /** The order routes over this rig's orders. */
  invoke: Invoke
  /** The same routes and service over a read side with no orders: what a number no order has gets. */
  nothing: Invoke
  close(): Promise<void>
}

export async function orderRig(): Promise<OrderRig> {
  const store = createCommandStore(
    // @ts-expect-error minimal config: the store reads only these
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(store, documentStore)
  const { publisher } = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus, logger },
  )
  const orders = createOrderService({
    store,
    repos,
    publisher,
    logger,
    orderNumberPrefix: 'NYM',
    orderNumberStart: 1000,
  })
  const served = makeAdapter()
  registerOrderRoutes(served.adapter, orders, documentStore)
  const empty = makeAdapter()
  registerOrderRoutes(empty.adapter, orders, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  return {
    store,
    repos,
    documentStore,
    invoke: served.invoke,
    nothing: empty.invoke,
    async close() {
      await store.close()
    },
  }
}

/** Writes the order's row and its read-side documents; answers the document the routes read. */
export async function placeOrder(
  rig: OrderRig,
  order: Order,
  history: OrderHistoryEntry[],
): Promise<OrderDoc> {
  await rig.store.transaction(async (tx) => {
    await rig.repos.order.insert(tx, {
      id: order.id,
      orderNumber: order.orderNumber,
      sequence: order.sequence,
      customerId: order.customerId,
      status: order.status,
      email: order.email,
      billingAddress: order.billingAddress,
      shippingAddress: order.shippingAddress,
      lineItems: order.lineItems,
      subtotalMinor: order.subtotalMinor,
      taxTotalMinor: order.taxTotalMinor,
      shippingTotalMinor: order.shippingTotalMinor,
      discountTotalMinor: order.discountTotalMinor,
      totalMinor: order.totalMinor,
      currency: order.currency,
      notes: order.notes,
      metadata: order.metadata,
      paymentIntentId: order.paymentIntentId,
      createdAt: new Date(order.createdAt),
      updatedAt: new Date(order.updatedAt),
    })
  })
  const doc = buildOrderDoc(order, history)
  for (const w of orderWrites(doc)) await rig.documentStore.put(w.collection, w.key, w.doc)
  return doc
}

/** A key row for the order, open until `expiresAt`. */
export function addKey(
  rig: OrderRig,
  orderId: string,
  key: string,
  opts: { expiresAt: Date; purpose?: 'checkout' | 'email'; createdAt?: Date },
): void {
  const clients = rawClients(rig.store)
  if (clients.kind !== 'sqlite') throw new Error('the order rig is SQLite')
  const createdAt = opts.createdAt ?? new Date(opts.expiresAt.getTime() - 48 * 3_600_000)
  clients.raw
    .prepare(
      'INSERT INTO order_access_keys (id, order_id, key_hash, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      uuidv7(),
      orderId,
      sha256(key),
      opts.purpose ?? 'checkout',
      createdAt.toISOString(),
      opts.expiresAt.toISOString(),
    )
}

/** The value of a response header, by its name in any case. */
export function headerOf(resp: ResponseEnvelope, name: string): string | undefined {
  return Object.entries(resp.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1]
}

/** What a JSON client receives: the body as it goes over the wire, `undefined` fields gone. */
export function wire(resp: ResponseEnvelope): string {
  return JSON.stringify(resp.body)
}
