import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { OrderStatus, PaymentState } from '@nymbalhq/types'
import { REFUND_NOTE_PREFIX } from '../order-history-notes.js'
import { orderTimeline } from './order-timeline.js'

// `orderTimeline(rows, state)` maps each `order_history` row to at most one entry, in row order, with the row's
// timestamp as `at` and nothing else. A status move is read by its from and to statuses. A refund is a same-status row
// with the refund note: partially_refunded, except that the last such row is refunded when the order's payment reads
// refunded (only the last can be: a refund that completes the amount leaves nothing refundable).

type Kind = 'placed' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'partially_refunded' | 'refunded'

interface Row {
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  actor: string
  note: string
  timestamp: string
}

const TABLE: Record<string, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
}

const STATES: readonly PaymentState[] = ['unpaid', 'paid', 'partially_refunded', 'refunded']
const FULFILMENT: readonly OrderStatus[] = ['confirmed', 'processing', 'shipped', 'delivered']

const AT = '2026-11-07T08:15:00.000Z'
const refundNote = (why = ''): string => `${REFUND_NOTE_PREFIX}£2.50${why === '' ? '' : `: ${why}`}`
const row = (fromStatus: OrderStatus | null, toStatus: OrderStatus, note = '', timestamp = AT): Row => ({
  fromStatus,
  toStatus,
  actor: 'admin:u-1',
  note,
  timestamp,
})

/** The entry a status move records, or null for one the timeline leaves out. */
function kindOfMove(from: OrderStatus, to: OrderStatus): Kind | null {
  if (from === 'pending' && to === 'confirmed') return 'paid'
  return to === 'shipped' || to === 'delivered' || to === 'cancelled' ? to : null
}

const timestamp = fc
  .date({
    min: new Date('2024-01-01T00:00:00Z'),
    max: new Date('2030-12-31T23:59:59Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString())

const notApplied = fc.constantFrom(
  'duplicate_capture_refunded',
  'order_cancelled_refunded',
  'amount_mismatch',
  'stock_unavailable',
)

type Step =
  | { kind: 'move'; pick: number }
  | { kind: 'refund'; why: string }
  | { kind: 'not-applied'; reason: string }

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.nat({ max: 9 }).map((pick): Step => ({ kind: 'move', pick })) },
  {
    weight: 3,
    arbitrary: fc.constantFrom('', 'damaged').map((why): Step => ({ kind: 'refund', why })),
  },
  {
    weight: 2,
    arbitrary: notApplied.map((reason): Step => ({ kind: 'not-applied', reason })),
  },
)

/**
 * The rows a walk of the table writes, with refund-note rows and captures that were not applied between them.
 * Timestamps are independent of row order, so an implementation that sorts by time is seen.
 */
const walk = fc
  .tuple(fc.array(fc.tuple(step, timestamp), { maxLength: 16 }), timestamp)
  .map(([steps, placedAt]) => {
    const rows: Row[] = [row(null, 'pending', 'order draft created', placedAt)]
    let status: OrderStatus = 'pending'
    for (const [s, at] of steps) {
      if (s.kind === 'move') {
        const next: readonly OrderStatus[] = TABLE[status]!
        if (next.length === 0) continue
        const to: OrderStatus = next[s.pick % next.length]!
        rows.push(row(status, to, to === 'shipped' ? 'Shipped via dpd: T-1' : '', at))
        status = to
      } else if (s.kind === 'refund') {
        rows.push(row(status, status, refundNote(s.why), at))
      } else {
        rows.push(row(status, status, `captured payment not applied: ${s.reason}`, at))
      }
    }
    return rows
  })

const isRefundRow = (r: Row): boolean =>
  r.fromStatus === r.toStatus && r.note.startsWith(REFUND_NOTE_PREFIX) && r.toStatus !== 'cancelled'

/** The entries a walk's rows must give for the payment state. */
function expected(rows: readonly Row[], state: PaymentState): Array<{ kind: Kind; at: string }> {
  const lastRefund = rows.findLastIndex(isRefundRow)
  const out: Array<{ kind: Kind; at: string }> = []
  rows.forEach((r, i) => {
    if (isRefundRow(r)) {
      out.push({
        kind: state === 'refunded' && i === lastRefund ? 'refunded' : 'partially_refunded',
        at: r.timestamp,
      })
      return
    }
    if (r.fromStatus === null) {
      if (r.toStatus === 'pending') out.push({ kind: 'placed', at: r.timestamp })
      return
    }
    if (r.fromStatus === r.toStatus) return
    const kind = kindOfMove(r.fromStatus, r.toStatus)
    if (kind !== null) out.push({ kind, at: r.timestamp })
  })
  return out
}

const state = fc.constantFrom(...STATES)

describe('AC-8: the timeline reads refunds from notes and the money', () => {
  // Defect: a full refund shows as partial or a partial as full, a refund vanishes from the timeline, one is shown on an
  // order that stayed cancelled, a capture that was not applied reads as a refund, or a status move is misread.
  it('AC-8: one row: a same-status refund-note row gives refunded on a fully refunded order and partially_refunded on any other, at every status but cancelled; any other note gives none; a move gives its own entry and a move to processing none', () => {
    const atStatus = [...FULFILMENT, 'pending' as const, 'cancelled' as const]
    const refundCases = atStatus.flatMap((status) =>
      STATES.map((s): [Row, PaymentState, Kind | null] => [
        row(status, status, refundNote()),
        s,
        status === 'cancelled' ? null : s === 'refunded' ? 'refunded' : 'partially_refunded',
      ]),
    )
    const otherNotes = [
      'captured payment not applied: duplicate_capture_refunded',
      '',
      'refunded',
      'manual note: refund of £1',
    ]
    const otherCases = STATES.flatMap((s) =>
      atStatus.flatMap((status) =>
        otherNotes.map((note): [Row, PaymentState, Kind | null] => [
          row(status, status, note),
          s,
          null,
        ]),
      ),
    )
    const moveCases: Array<[Row, PaymentState, Kind | null]> = [
      [row(null, 'pending', 'order draft created'), 'unpaid', 'placed'],
      [row('pending', 'confirmed', 'payment captured'), 'paid', 'paid'],
      [row('processing', 'shipped', 'Shipped via dpd: T-9'), 'paid', 'shipped'],
      [row('shipped', 'delivered'), 'refunded', 'delivered'],
      [row('pending', 'cancelled', 'Cancelled by admin'), 'unpaid', 'cancelled'],
      [row('confirmed', 'processing'), 'paid', null],
    ]
    const cases = [...refundCases, ...otherCases, ...moveCases]
    expect(cases.map(([r, s]) => orderTimeline([r], s))).toEqual(
      cases.map(([, , kind]) => (kind === null ? [] : [{ kind, at: AT }])),
    )
  })

  // Defect: a full refund shows as partial, every refund of a fully refunded order shows as full, or the wrong one does.
  it('AC-8: with the payment state refunded, the last refund-note row gives refunded and earlier ones partially_refunded, and the same rows on a partially refunded order give partially_refunded throughout', () => {
    const rows = [
      row('confirmed', 'confirmed', refundNote(), '2026-11-07T08:00:00.000Z'),
      row('confirmed', 'processing', '', '2026-11-07T08:10:00.000Z'),
      row('processing', 'processing', refundNote('damaged'), '2026-11-07T08:20:00.000Z'),
      row('processing', 'processing', refundNote(), '2026-11-07T08:30:00.000Z'),
    ]
    const kinds = (s: PaymentState) => orderTimeline(rows, s).map((e) => [e.kind, e.at])
    expect(kinds('refunded')).toEqual([
      ['partially_refunded', '2026-11-07T08:00:00.000Z'],
      ['partially_refunded', '2026-11-07T08:20:00.000Z'],
      ['refunded', '2026-11-07T08:30:00.000Z'],
    ])
    expect(kinds('partially_refunded')).toEqual(
      kinds('refunded').map(([, at]) => ['partially_refunded', at]),
    )
  })

  // Defect: refund rows are dropped, reordered or sorted by time, an entry carries the row's actor or note, or more
  // than one row reads refunded.
  it('AC-8: property: over generated row walks and payment states, refund entries are one per refund-note row not at cancelled in row order, at most one is refunded and it is the last, and every other row gives its move’s entry', () => {
    fc.assert(
      fc.property(walk, state, (rows, s) => {
        const before = JSON.stringify(rows)
        const timeline = orderTimeline(rows, s)
        expect(timeline).toEqual(expected(rows, s))

        const refunds = timeline.filter((e) => e.kind === 'partially_refunded' || e.kind === 'refunded')
        const refundRows = rows.filter(isRefundRow)
        expect(refunds.map((e) => e.at)).toEqual(refundRows.map((r) => r.timestamp))
        const full = refunds.flatMap((e, i) => (e.kind === 'refunded' ? [i] : []))
        expect(full.length).toBeLessThanOrEqual(1)
        expect(full).toEqual(s === 'refunded' && refunds.length > 0 ? [refunds.length - 1] : [])

        expect(timeline.map((e: object) => Object.keys(e).sort())).toEqual(
          timeline.map(() => ['at', 'kind']),
        )
        expect(JSON.stringify(rows), 'the rows are left as they were').toBe(before)
      }),
      { numRuns: 400 },
    )
  })
})
