import type {
  OrderStatus,
  OrderTimelineEntry,
  OrderTimelineKind,
  PaymentState,
} from '@nymbalhq/types'
import { REFUND_NOTE_PREFIX } from '../order-history-notes.js'

interface HistoryRow {
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  note: string
  timestamp: string
}

const MOVES: Partial<Record<OrderStatus, OrderTimelineKind>> = {
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
}

/** A settled refund's row: it stays at its status, and only the note tells it from a captured payment not applied. */
function isRefund(row: HistoryRow): boolean {
  return (
    row.fromStatus === row.toStatus &&
    row.toStatus !== 'cancelled' &&
    row.note.startsWith(REFUND_NOTE_PREFIX)
  )
}

function moveKind(row: HistoryRow): OrderTimelineKind | null {
  const { fromStatus: from, toStatus: to } = row
  if (from === null) return to === 'pending' ? 'placed' : null
  if (from === to) return null
  if (from === 'pending' && to === 'confirmed') return 'paid'
  return MOVES[to] ?? null
}

/**
 * The order's lifecycle events, one per history row that records one, in row order. Refunds come from the rows and the
 * money: a refund that completes the amount is necessarily the last, so only that row reads `refunded`.
 */
export function orderTimeline(
  history: ReadonlyArray<HistoryRow>,
  state: PaymentState,
): OrderTimelineEntry[] {
  const lastRefund = history.findLastIndex(isRefund)
  const entries: OrderTimelineEntry[] = []
  history.forEach((row, i) => {
    const kind = isRefund(row)
      ? i === lastRefund && state === 'refunded'
        ? 'refunded'
        : 'partially_refunded'
      : moveKind(row)
    if (kind !== null) entries.push({ kind, at: row.timestamp })
  })
  return entries
}
