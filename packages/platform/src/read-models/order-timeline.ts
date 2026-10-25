import type { OrderStatus, OrderTimelineEntry, OrderTimelineKind } from '@nymbalhq/types'
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
  refunded: 'refunded',
  partially_refunded: 'partially_refunded',
}

function kindOf(row: HistoryRow): OrderTimelineKind | null {
  const { fromStatus: from, toStatus: to } = row
  if (from === null) return to === 'pending' ? 'placed' : null
  if (from === to) {
    // A same-status row is a further partial refund or a captured payment that was not applied; only the note
    // tells them apart.
    return to === 'partially_refunded' && row.note.startsWith(REFUND_NOTE_PREFIX)
      ? 'partially_refunded'
      : null
  }
  if (from === 'pending' && to === 'confirmed') return 'paid'
  return MOVES[to] ?? null
}

/** The order's lifecycle events, one per history row that records one, in row order. */
export function orderTimeline(history: ReadonlyArray<HistoryRow>): OrderTimelineEntry[] {
  const entries: OrderTimelineEntry[] = []
  for (const row of history) {
    const kind = kindOf(row)
    if (kind !== null) entries.push({ kind, at: row.timestamp })
  }
  return entries
}
