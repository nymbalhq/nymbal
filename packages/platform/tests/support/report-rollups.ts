import fc from 'fast-check'
import { randomUUID } from 'node:crypto'
import type { NymbalEvent, Order, OrderLineItem, OrderSource } from '@nymbalhq/types'
import { createEventBuilder } from '../../src/events/builder.js'
import { TEST_BUILDER_CONTEXT } from '../../src/tests/publisher.js'
import { address, type Kernel } from './kernel.js'
import { writeRaw, type RawReader } from './raw.js'
import { unaudited } from './write-audit.js'

// What the report-rollup suites share: orders and carts of every source, the rollup event types as a generator, one
// delivery of an event to the kernel's own bus, and the report tables as a second connection reads them, in the form a
// `recompute` of the same events is compared to. Nothing here knows how the fold or the handler is built.

/** The zone `kernelConfig` gives the store. */
export const ZONE = 'Europe/London'

export const ROLLUP_TABLES = [
  'report_sales_hours',
  'report_funnel_days',
  'report_product_days',
  'report_search_days',
  'report_members',
] as const

export const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

/** A source no type names yet; a cart or order carrying it must leave no trace. */
export const SYNTHETIC = 'synthetic' as string as OrderSource

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The store day (`YYYY-MM-DD`, in the store's zone) an instant falls on, computed apart from the code under test. */
export function storeDay(at: Date): string {
  return dayFormat.format(at)
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** An instant safely inside a store day, away from any clock change. */
export const noonOf = (day: string, minutes = 0): Date =>
  new Date(new Date(`${day}T12:00:00.000Z`).getTime() + minutes * 60_000)

/** Empties the report tables, so one kernel serves many runs. */
export async function clearReports(k: Pick<Kernel, 'dialect' | 'target'>): Promise<void> {
  for (const table of ROLLUP_TABLES) await writeRaw(k.dialect, k.target, `DELETE FROM ${table}`)
}

/** One delivery of `event` on the kernel's bus, as the relay makes it. */
export async function deliver(k: Pick<Kernel, 'eventBus'>, event: NymbalEvent<unknown>) {
  await k.eventBus.publish(event)
}

let sequence = 800_000

function lineOf(variantId: string, productId: string, qty: number, unitPriceMinor: number) {
  const line: OrderLineItem = {
    variantId,
    productId,
    productName: `Product ${productId.slice(0, 8)}`,
    variantName: `Variant ${variantId.slice(0, 8)}`,
    sku: `SKU-${variantId.slice(0, 8)}`,
    qty,
    unitPriceMinor,
    lineSubtotalMinor: qty * unitPriceMinor,
    lineTaxMinor: 0,
    lineTotalMinor: qty * unitPriceMinor,
    imageUrl: '',
  }
  return line
}

export interface OrderSeed {
  source?: OrderSource
  currency?: string
  /** An `[variantId, productId, qty, unitPriceMinor]` for each line; two lines of fresh ids when absent. */
  lines?: ReadonlyArray<readonly [string, string, number, number]>
  createdAt?: Date
  capturedMinor?: number
  refundedMinor?: number
}

/** An order row of the given source, as the fold's lookup reads it: inserted through the repository, unaudited. */
export async function seedOrder(
  k: Pick<Kernel, 'store' | 'repos'>,
  seed: OrderSeed = {},
): Promise<Order> {
  sequence += 1
  const id = randomUUID()
  const lineItems = (
    seed.lines ?? [
      [randomUUID(), randomUUID(), 2, 500],
      [randomUUID(), randomUUID(), 1, 750],
    ]
  ).map(([variantId, productId, qty, unit]) => lineOf(variantId, productId, qty, unit))
  const totalMinor = lineItems.reduce((sum, l) => sum + l.lineTotalMinor, 0)
  const createdAt = seed.createdAt ?? new Date('2026-10-15T12:00:00.000Z')
  await unaudited(() =>
    k.store.transaction((tx) =>
      k.repos.order.insert(tx, {
        id,
        orderNumber: `RPT-${sequence}`,
        sequence,
        customerId: null,
        status: 'processing',
        email: `order-${id}@reports.test`,
        billingAddress: address,
        shippingAddress: address,
        lineItems,
        subtotalMinor: totalMinor,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor,
        currency: seed.currency ?? 'GBP',
        paymentIntentId: `pi_${id}`,
        source: seed.source ?? 'storefront',
        ...(seed.capturedMinor !== undefined && {
          capture: {
            amountMinor: seed.capturedMinor,
            method: seed.source === 'import' ? ('import' as const) : ('provider' as const),
            at: createdAt,
            refundedMinor: seed.refundedMinor ?? 0,
          },
        }),
        createdAt,
        updatedAt: createdAt,
      }),
    ),
  )
  return (await k.store.read((tx) => k.repos.order.findById(tx, id)))!
}

/** A live cart row carrying `source`, through the cart service; synthetic is written after, as nothing makes one yet. */
export async function seedCart(
  k: Pick<Kernel, 'services' | 'dialect' | 'target'>,
  source: OrderSource = 'storefront',
): Promise<string> {
  const known = source === SYNTHETIC ? 'storefront' : (source as 'storefront' | `agent:${string}`)
  const cart = await k.services.cart.getOrCreate(undefined, null, known)
  if (source === SYNTHETIC) {
    await writeRaw(k.dialect, k.target, 'UPDATE carts SET source = ? WHERE token = ?', [
      SYNTHETIC,
      cart.token,
    ])
  }
  return cart.token
}

export interface Pool {
  orders: Order[]
  cartTokens: string[]
  /** The lookup a `recompute` of events over this pool reads: the orders and carts the kernel holds. */
  lookup: {
    orderOf(id: string): Order | null
    cartSourceOf(token: string): string | null
  }
}

/** Orders and carts of every source and currency the generators draw from. */
export async function seedPool(
  k: Pick<Kernel, 'store' | 'repos' | 'services' | 'dialect' | 'target'>,
): Promise<Pool> {
  const orders: Order[] = []
  for (const currency of ['GBP', 'EUR']) {
    for (const source of ['storefront', 'import', 'agent:scout', SYNTHETIC] as const) {
      orders.push(
        await seedOrder(k, {
          source: source as OrderSource,
          currency,
          capturedMinor: 1_750,
          refundedMinor: source === 'import' ? 250 : 0,
        }),
      )
    }
  }
  const carts = new Map<string, string>()
  for (const source of ['storefront', 'agent:scout', SYNTHETIC] as const) {
    const token = await seedCart(k, source as OrderSource)
    carts.set(token, source)
  }
  const byId = new Map(orders.map((o) => [o.id, o]))
  return {
    orders,
    cartTokens: [...carts.keys()],
    lookup: {
      orderOf: (id) => byId.get(id) ?? null,
      cartSourceOf: (token) => carts.get(token) ?? null,
    },
  }
}

/** The event a store emits for this figure. */
export const events = {
  captured: (order: Order, amountMinor: number, at: Date) =>
    makeEvent(
      'payment.captured.v1',
      { paymentId: `pi_${order.id}`, orderId: order.id, amountMinor, currency: order.currency },
      { timestamp: at },
    ),
  refunded: (order: Order, amountMinor: number, at: Date) =>
    makeEvent(
      'payment.refunded.v1',
      {
        paymentId: `pi_${order.id}`,
        orderId: order.id,
        refundId: `re_${randomUUID()}`,
        amountMinor,
        currency: order.currency,
      },
      { timestamp: at },
    ),
  paid: (order: Order, at: Date) =>
    makeEvent(
      'order.paid.v1',
      {
        orderId: order.id,
        paymentIntentId: `pi_${order.id}`,
        amountMinor: order.totalMinor,
        currency: order.currency,
      },
      { timestamp: at },
    ),
  placed: (order: Order, at: Date) => makeEvent('order.placed.v1', { order }, { timestamp: at }),
  deleted: (order: Order, at: Date) =>
    makeEvent(
      'order.deleted.v1',
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        createdAt: order.createdAt,
        source: order.source,
        currency: order.currency,
        capturedMinor: order.capturedMinor,
        refundedMinor: order.refundedMinor,
        lineItems: order.lineItems,
      },
      { timestamp: at },
    ),
  cartAdded: (token: string, at: Date) =>
    makeEvent(
      'cart.item_added.v1',
      { cartId: token, variantId: randomUUID(), qty: 1 },
      { timestamp: at },
    ),
  intent: (order: Order, at: Date) =>
    makeEvent(
      'payment.intent_created.v1',
      { paymentId: `pi_${order.id}`, orderId: order.id },
      { timestamp: at },
    ),
  failed: (orderId: string, reason: string, at: Date) =>
    makeEvent(
      'payment.failed.v1',
      { paymentId: `pi_${orderId || 'none'}`, orderId, reason },
      { timestamp: at },
    ),
  viewed: (id: string, at: Date, kind: 'visitor' | 'customer' = 'visitor') =>
    makeEvent(
      'product.viewed.v1',
      { productId: randomUUID(), viewer: { kind, id } },
      { timestamp: at },
    ),
  searched: (term: string, at: Date) =>
    makeEvent('search.zero_results.v1', { term }, { timestamp: at }),
}

export interface EventWindow {
  base: Date
  hours: number
}

/** Twelve days around the UK's clock change of 2026-10-25. */
export const AROUND_CLOCK_CHANGE: EventWindow = {
  base: new Date('2026-10-20T00:00:00.000Z'),
  hours: 12 * 24,
}

const REASONS = [
  'payment_failed',
  'Your card was declined.',
  'no_order',
  'amount_mismatch',
  'order_not_pending: shipped',
  'malformed_capture',
]

const VIEWERS = ['viewer-a', 'viewer-b', 'viewer-c']
const TERMS = ['blue widget', 'left handed teapot', 'unicorn mug']

/** Any rollup event over the pool, its timestamp inside `window`. */
export function rollupEventArb(pool: Pool, window: EventWindow): fc.Arbitrary<NymbalEvent<unknown>> {
  const at = fc
    .integer({ min: 0, max: window.hours * 60 })
    .map((minutes) => new Date(window.base.getTime() + minutes * 60_000))
  const order = fc.constantFrom(...pool.orders)
  const amount = fc.integer({ min: 1, max: 40_000 })
  const reason = fc.constantFrom(...REASONS)
  const orderId = fc.constantFrom(...pool.orders.map((o) => o.id), '', randomUUID())
  const viewer = fc.tuple(fc.constantFrom(...VIEWERS), fc.constantFrom('visitor', 'customer'))
  return fc.oneof(
    fc.tuple(order, amount, at).map(([o, a, t]) => events.captured(o, a, t)),
    fc.tuple(order, amount, at).map(([o, a, t]) => events.refunded(o, a, t)),
    fc.tuple(order, at).map(([o, t]) => events.paid(o, t)),
    fc.tuple(order, at).map(([o, t]) => events.placed(o, t)),
    fc.tuple(order, at).map(([o, t]) => events.deleted(o, t)),
    fc.tuple(fc.constantFrom(...pool.cartTokens), at).map(([c, t]) => events.cartAdded(c, t)),
    fc.tuple(order, at).map(([o, t]) => events.intent(o, t)),
    fc.tuple(orderId, reason, at).map(([o, r, t]) => events.failed(o, r, t)),
    fc
      .tuple(viewer, at)
      .map(([[id, kind], t]) => events.viewed(id, t, kind as 'visitor' | 'customer')),
    fc.tuple(fc.constantFrom(...TERMS), at).map(([term, t]) => events.searched(term, t)),
  )
}

/** Each index in `0..n-1` at least once, some repeated, in any order. */
export function deliveryOrders(n: number): fc.Arbitrary<number[]> {
  return fc
    .array(fc.integer({ min: 0, max: n - 1 }), { maxLength: n })
    .chain((repeats) => {
      const all = [...Array.from({ length: n }, (_, i) => i), ...repeats]
      return fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
    })
}

type Row = Record<string, unknown>

/** The report tables' figures in one form, whichever side they came from; `hourStart` as an instant, sorted. */
export interface RollupTables {
  salesHours: Row[]
  funnelDays: Row[]
  productDays: Row[]
  searchDays: Row[]
  members: Row[]
}

const SHAPES = {
  salesHours: {
    table: 'report_sales_hours',
    columns: {
      hour_start: 'hourStart',
      local_day: 'localDay',
      timezone: 'timezone',
      currency: 'currency',
      source: 'source',
      captured_minor: 'capturedMinor',
      refunded_minor: 'refundedMinor',
      paid_orders: 'paidOrders',
    },
    counters: ['capturedMinor', 'refundedMinor', 'paidOrders'],
  },
  funnelDays: {
    table: 'report_funnel_days',
    columns: {
      local_day: 'localDay',
      source: 'source',
      timezone: 'timezone',
      viewers: 'viewers',
      carts_with_items: 'cartsWithItems',
      checkouts_started: 'checkoutsStarted',
      payments_failed: 'paymentsFailed',
    },
    counters: ['viewers', 'cartsWithItems', 'checkoutsStarted', 'paymentsFailed'],
  },
  productDays: {
    table: 'report_product_days',
    columns: {
      local_day: 'localDay',
      variant_id: 'variantId',
      currency: 'currency',
      source: 'source',
      timezone: 'timezone',
      product_id: 'productId',
      product_name: 'productName',
      variant_name: 'variantName',
      sku: 'sku',
      units: 'units',
      line_subtotal_minor: 'lineSubtotalMinor',
    },
    counters: ['units', 'lineSubtotalMinor'],
  },
  searchDays: {
    table: 'report_search_days',
    columns: {
      local_day: 'localDay',
      term: 'term',
      timezone: 'timezone',
      searches: 'searches',
    },
    counters: ['searches'],
  },
  members: {
    table: 'report_members',
    columns: { kind: 'kind', local_day: 'localDay', member: 'member' },
    counters: [],
  },
} as const

type TableName = keyof typeof SHAPES

function canonical(row: Row, table: TableName): Row | null {
  const out: Row = {}
  for (const camel of Object.values(SHAPES[table].columns) as string[]) {
    let value = row[camel]
    if (camel === 'hourStart') value = new Date(value as string | number | Date).toISOString()
    if ((SHAPES[table].counters as readonly string[]).includes(camel)) value = Number(value)
    out[camel] = value
  }
  const counters = SHAPES[table].counters as readonly string[]
  // A row every delivery has netted to zero says nothing the absence of a row does not.
  if (counters.length > 0 && counters.every((c) => out[c] === 0)) return null
  return out
}

function ordered(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

/** `recompute`'s answer, in the form `storedRollups` reads. */
export function canonicalRollups(recomputed: unknown): RollupTables {
  const from = recomputed as Partial<Record<TableName, Row[]>>
  const out = {} as RollupTables
  for (const table of Object.keys(SHAPES) as TableName[]) {
    out[table] = ordered(
      (from[table] ?? [])
        .map((row) => canonical(row, table))
        .filter((row): row is Row => row !== null),
    )
  }
  return out
}

/** The report tables as a second connection reads them. */
export async function storedRollups(raw: RawReader): Promise<RollupTables> {
  const out = {} as RollupTables
  for (const table of Object.keys(SHAPES) as TableName[]) {
    const rows = await raw.rows<Row>(`SELECT * FROM ${SHAPES[table].table}`)
    out[table] = ordered(
      rows
        .map((row) => {
          const camel: Row = {}
          for (const [col, name] of Object.entries(SHAPES[table].columns)) camel[name] = row[col]
          return canonical(camel, table)
        })
        .filter((row): row is Row => row !== null),
    )
  }
  return out
}

export interface MoneyBySource {
  source: string
  capturedMinor: number
  refundedMinor: number
  netCapturedMinor: number
  paidOrders: number
}

export interface MoneyTotal {
  currency: string
  window: Row
  capturedMinor: number
  refundedMinor: number
  netCapturedMinor: number
  paidOrders: number
  bySource: MoneyBySource[]
}

export interface MoneyRow extends Omit<MoneyTotal, 'window'> {
  bucket: string
  partial: boolean
  timezone: string
}

export interface FunnelTotal {
  source: string
  window: Row
  viewers: number
  cartsWithItems: number
  checkoutsStarted: number
  paymentsFailed: number
  paidOrders: number
}

export interface Rate {
  rate: number | null
  paidOrders: number
  checkoutsStarted?: number
  cartsWithItems?: number
  viewers?: number
  basis: string
  window: Row
  reason?: string
}

export interface ProductItem {
  productId: string
  productName: string
  currency: string
  units: number
  lineSubtotalMinor: number
  bySource: unknown[]
}

export interface RunwayItem {
  variantId: string
  productId: string
  productName: string
  sku: string
  stock: number
  unitsSold: number
  windowDays: number
  daysLeft: number
  reason?: string
}

/** The default answer of `GET /api/admin/reports`. */
export interface ReportBody {
  window: { from: string; to: string; timezone: string; grain: string | null; closedThrough: string }
  since: string | null
  definitions: Record<string, string>
  money: { totals: MoneyTotal[] }
  funnel: { totals: FunnelTotal[] }
  rates: {
    paidPerCheckoutStarted: Rate
    paidPerCartWithItems: Rate
    paidPerMeasuredViewer: Rate
  }
  topProducts: { window: Row; items: ProductItem[] }
  zeroResultSearches: { window: Row; items: Array<{ term: string; searches: number }> }
  stockRunway: { window: Row; items: RunwayItem[] }
}

/** The answer with `grain`. */
export interface GrainBody {
  window: ReportBody['window']
  since: string | null
  definitions: Record<string, string>
  money: { series: MoneyRow[] }
  funnel?: { series: Array<Row & { bucket: string; partial: boolean; source: string }> }
}
