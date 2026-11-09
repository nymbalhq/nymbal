import { createHash } from 'node:crypto'
import {
  EVT_CART_ITEM_ADDED,
  EVT_ORDER_DELETED,
  EVT_ORDER_PAID,
  EVT_ORDER_PLACED,
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_FAILED,
  EVT_PAYMENT_INTENT_CREATED,
  EVT_PAYMENT_REFUNDED,
  EVT_PRODUCT_VIEWED,
  EVT_SEARCH_ZERO_RESULTS,
  type CartItemAddedV1Payload,
  type NymbalEvent,
  type Order,
  type OrderDeletedV1Payload,
  type OrderLineItem,
  type OrderPaidV1Payload,
  type OrderPlacedV1Payload,
  type PaymentCapturedV1Payload,
  type PaymentFailedV1Payload,
  type PaymentIntentCreatedV1Payload,
  type PaymentRefundedV1Payload,
  type ProductViewedV1Payload,
  type SearchZeroResultsV1Payload,
} from '@nymbalhq/types'
import { isDecline } from './definitions.js'
import { localDayOf, localHourStartOf } from './time.js'

// The fold of one event into the figures it moves: the only place an event becomes a figure. The live handler applies
// these deltas; `recompute` adds them up the same way, so the two cannot disagree.

export const ROLLUP_EVENT_TYPES = [
  EVT_PAYMENT_CAPTURED,
  EVT_PAYMENT_REFUNDED,
  EVT_ORDER_PAID,
  EVT_ORDER_PLACED,
  EVT_ORDER_DELETED,
  EVT_CART_ITEM_ADDED,
  EVT_PAYMENT_INTENT_CREATED,
  EVT_PAYMENT_FAILED,
  EVT_PRODUCT_VIEWED,
  EVT_SEARCH_ZERO_RESULTS,
] as const

const SYNTHETIC = 'synthetic'

export interface RollupLookup {
  orderOf(id: string): Order | null
  cartSourceOf(token: string): string | null
}

/** A day-scoped digest of who a distinct counter has counted; the counter moves only when this is new. */
export interface RollupMember {
  kind: 'viewer' | 'cart' | 'checkout'
  localDay: string
  member: string
}

export interface SalesHourDelta {
  table: 'salesHours'
  hourStart: Date
  localDay: string
  timezone: string
  currency: string
  source: string
  capturedMinor: number
  refundedMinor: number
  paidOrders: number
}

export interface FunnelDayDelta {
  table: 'funnelDays'
  localDay: string
  timezone: string
  source: string
  viewers: number
  cartsWithItems: number
  checkoutsStarted: number
  paymentsFailed: number
  member?: RollupMember
}

export interface ProductDayDelta {
  table: 'productDays'
  localDay: string
  timezone: string
  variantId: string
  currency: string
  source: string
  productId: string
  productName: string
  variantName: string
  sku: string
  units: number
  lineSubtotalMinor: number
}

export interface SearchDayDelta {
  table: 'searchDays'
  localDay: string
  timezone: string
  term: string
  searches: number
}

export type RollupDelta = SalesHourDelta | FunnelDayDelta | ProductDayDelta | SearchDayDelta

export type SalesHourRow = Omit<SalesHourDelta, 'table'>
export type FunnelDayRow = Omit<FunnelDayDelta, 'table' | 'member'>
export type ProductDayRow = Omit<ProductDayDelta, 'table'>
export type SearchDayRow = Omit<SearchDayDelta, 'table'>

export interface RollupRows {
  salesHours: SalesHourRow[]
  funnelDays: FunnelDayRow[]
  productDays: ProductDayRow[]
  searchDays: SearchDayRow[]
  members: RollupMember[]
}

function digest(localDay: string, id: string): string {
  return createHash('sha256').update(`${localDay}:${id}`).digest('hex')
}

/** A source that counts: a known one, not `synthetic`. */
function countedSource(source: string | null | undefined): string | null {
  return source == null || source === SYNTHETIC ? null : source
}

function salesAt(
  at: Date,
  timeZone: string,
  currency: string,
  source: string,
  figures: { capturedMinor?: number; refundedMinor?: number; paidOrders?: number },
): SalesHourDelta {
  return {
    table: 'salesHours',
    hourStart: localHourStartOf(at, timeZone),
    localDay: localDayOf(at, timeZone),
    timezone: timeZone,
    currency,
    source,
    capturedMinor: figures.capturedMinor ?? 0,
    refundedMinor: figures.refundedMinor ?? 0,
    paidOrders: figures.paidOrders ?? 0,
  }
}

function linesAt(
  at: Date,
  timeZone: string,
  currency: string,
  source: string,
  lines: readonly OrderLineItem[],
  sign: 1 | -1,
): ProductDayDelta[] {
  return lines.map((line) => ({
    table: 'productDays',
    localDay: localDayOf(at, timeZone),
    timezone: timeZone,
    variantId: line.variantId,
    currency,
    source,
    productId: line.productId,
    productName: line.productName,
    variantName: line.variantName,
    sku: line.sku,
    units: sign * line.qty,
    lineSubtotalMinor: sign * line.lineSubtotalMinor,
  }))
}

function funnelCount(
  at: Date,
  timeZone: string,
  source: string,
  counter: 'viewers' | 'cartsWithItems' | 'checkoutsStarted' | 'paymentsFailed',
  distinct?: { kind: RollupMember['kind']; id: string },
): FunnelDayDelta {
  const localDay = localDayOf(at, timeZone)
  return {
    table: 'funnelDays',
    localDay,
    timezone: timeZone,
    source,
    viewers: 0,
    cartsWithItems: 0,
    checkoutsStarted: 0,
    paymentsFailed: 0,
    [counter]: 1,
    ...(distinct !== undefined && {
      member: { kind: distinct.kind, localDay, member: digest(localDay, distinct.id) },
    }),
  }
}

/** An imported order's figures, on its own day: the same ones it adds on import and takes back on removal. */
function importFigures(
  createdAt: string,
  currency: string,
  capturedMinor: number,
  refundedMinor: number,
  lineItems: readonly OrderLineItem[],
  timeZone: string,
  sign: 1 | -1,
): RollupDelta[] {
  if (capturedMinor === 0 && refundedMinor === 0) return []
  const at = new Date(createdAt)
  const paid = capturedMinor > 0
  return [
    salesAt(at, timeZone, currency, 'import', {
      capturedMinor: sign * capturedMinor,
      refundedMinor: sign * refundedMinor,
      paidOrders: paid ? sign : 0,
    }),
    ...(paid ? linesAt(at, timeZone, currency, 'import', lineItems, sign) : []),
  ]
}

/** The figures one event moves. Pure: the same event, lookup and zone give the same deltas. */
export function foldEvent(
  event: NymbalEvent<unknown>,
  lookup: RollupLookup,
  timeZone: string,
): RollupDelta[] {
  const at = new Date(event.timestamp)
  const orderSource = (orderId: string) => countedSource(lookup.orderOf(orderId)?.source)

  switch (event.type) {
    case EVT_PAYMENT_CAPTURED: {
      const p = event.payload as PaymentCapturedV1Payload
      const source = orderSource(p.orderId)
      if (source === null) return []
      return [salesAt(at, timeZone, p.currency, source, { capturedMinor: p.amountMinor })]
    }
    case EVT_PAYMENT_REFUNDED: {
      const p = event.payload as PaymentRefundedV1Payload
      const source = orderSource(p.orderId)
      if (source === null) return []
      return [salesAt(at, timeZone, p.currency, source, { refundedMinor: p.amountMinor })]
    }
    case EVT_ORDER_PAID: {
      const p = event.payload as OrderPaidV1Payload
      const order = lookup.orderOf(p.orderId)
      const source = countedSource(order?.source)
      if (order === null || source === null) return []
      return [
        salesAt(at, timeZone, p.currency, source, { paidOrders: 1 }),
        ...linesAt(at, timeZone, p.currency, source, order.lineItems, 1),
      ]
    }
    case EVT_ORDER_PLACED: {
      const { order } = event.payload as OrderPlacedV1Payload
      if (order.source !== 'import') return []
      return importFigures(
        order.createdAt,
        order.currency,
        order.capturedMinor,
        order.refundedMinor,
        order.lineItems,
        timeZone,
        1,
      )
    }
    case EVT_ORDER_DELETED: {
      const p = event.payload as OrderDeletedV1Payload
      // Only an import adds figures on its way in, so only an import has any to take back.
      if (p.source !== 'import') return []
      return importFigures(
        p.createdAt,
        p.currency,
        p.capturedMinor,
        p.refundedMinor,
        p.lineItems,
        timeZone,
        -1,
      )
    }
    case EVT_CART_ITEM_ADDED: {
      const p = event.payload as CartItemAddedV1Payload
      const source = lookup.cartSourceOf(p.cartId) ?? 'storefront'
      if (source === SYNTHETIC) return []
      return [funnelCount(at, timeZone, source, 'cartsWithItems', { kind: 'cart', id: p.cartId })]
    }
    case EVT_PAYMENT_INTENT_CREATED: {
      const p = event.payload as PaymentIntentCreatedV1Payload
      const source = orderSource(p.orderId)
      if (source === null) return []
      return [funnelCount(at, timeZone, source, 'checkoutsStarted', { kind: 'checkout', id: p.orderId })]
    }
    case EVT_PAYMENT_FAILED: {
      const p = event.payload as PaymentFailedV1Payload
      if (!isDecline(p.reason)) return []
      const source = orderSource(p.orderId)
      if (source === null) return []
      return [funnelCount(at, timeZone, source, 'paymentsFailed')]
    }
    case EVT_PRODUCT_VIEWED: {
      const p = event.payload as ProductViewedV1Payload
      return [funnelCount(at, timeZone, 'storefront', 'viewers', { kind: 'viewer', id: p.viewer.id })]
    }
    case EVT_SEARCH_ZERO_RESULTS: {
      const p = event.payload as SearchZeroResultsV1Payload
      return [
        {
          table: 'searchDays',
          localDay: localDayOf(at, timeZone),
          timezone: timeZone,
          term: p.term,
          searches: 1,
        },
      ]
    }
    default:
      return []
  }
}

function addTo<T>(rows: Map<string, T>, key: string, row: T, add: (held: T, next: T) => void): void {
  const held = rows.get(key)
  if (held === undefined) rows.set(key, { ...row })
  else add(held, row)
}

/** The tables a fold of each distinct event id once leaves: what the live handler's deliveries must leave too. */
export function recompute(
  events: readonly NymbalEvent<unknown>[],
  lookup: RollupLookup,
  timeZone: string,
): RollupRows {
  const seen = new Set<string>()
  const members = new Map<string, RollupMember>()
  const salesHours = new Map<string, SalesHourRow>()
  const funnelDays = new Map<string, FunnelDayRow>()
  const productDays = new Map<string, ProductDayRow>()
  const searchDays = new Map<string, SearchDayRow>()

  for (const event of events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    for (const delta of foldEvent(event, lookup, timeZone)) {
      switch (delta.table) {
        case 'salesHours': {
          const { table: _table, ...row } = delta
          const key = `${row.hourStart.toISOString()}|${row.currency}|${row.source}`
          addTo(salesHours, key, row, (held, next) => {
            held.capturedMinor += next.capturedMinor
            held.refundedMinor += next.refundedMinor
            held.paidOrders += next.paidOrders
          })
          break
        }
        case 'funnelDays': {
          if (delta.member !== undefined) {
            const memberKey = `${delta.member.kind}|${delta.member.localDay}|${delta.member.member}`
            if (members.has(memberKey)) break
            members.set(memberKey, delta.member)
          }
          const { table: _table, member: _member, ...row } = delta
          addTo(funnelDays, `${row.localDay}|${row.source}`, row, (held, next) => {
            held.viewers += next.viewers
            held.cartsWithItems += next.cartsWithItems
            held.checkoutsStarted += next.checkoutsStarted
            held.paymentsFailed += next.paymentsFailed
          })
          break
        }
        case 'productDays': {
          const { table: _table, ...row } = delta
          const key = `${row.localDay}|${row.variantId}|${row.currency}|${row.source}`
          addTo(productDays, key, row, (held, next) => {
            held.units += next.units
            held.lineSubtotalMinor += next.lineSubtotalMinor
          })
          break
        }
        case 'searchDays': {
          const { table: _table, ...row } = delta
          addTo(searchDays, `${row.localDay}|${row.term}`, row, (held, next) => {
            held.searches += next.searches
          })
          break
        }
      }
    }
  }

  return {
    salesHours: [...salesHours.values()],
    funnelDays: [...funnelDays.values()],
    productDays: [...productDays.values()],
    searchDays: [...searchDays.values()],
    members: [...members.values()],
  }
}
