import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from '@nymbalhq/types'
import { REFUND_NOTE_PREFIX } from '../order-history-notes.js'
import { orderTimeline } from './order-timeline.js'

// AC-1: `orderTimeline` maps each `order_history` row to at most one entry, in row order, with the row's timestamp as
// `at` and nothing else. A row is read by its from and to statuses, and a same-status row by its note: a further
// partial refund (its note starts with the refund prefix) is a second `partially_refunded`; a captured payment that
// was not applied, at any status, is no entry; nor is a move to processing.

type Kind =
  | 'placed'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded'

interface Row {
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  actor: string
  note: string
  timestamp: string
}

/** The entry a lifecycle move from → to records, or null for a move the timeline leaves out. */
function kindOfMove(from: OrderStatus, to: OrderStatus): Kind | null {
  if (from === 'pending' && to === 'confirmed') return 'paid'
  switch (to) {
    case 'shipped':
    case 'delivered':
    case 'cancelled':
    case 'refunded':
    case 'partially_refunded':
      return to
    default:
      return null
  }
}

const timestamp = fc
  .date({
    min: new Date('2024-01-01T00:00:00Z'),
    max: new Date('2030-12-31T23:59:59Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString())

const actor = fc.constantFrom(
  'system:checkout',
  'system:checkout-finalize',
  'admin:u-1',
  'admin:u-2',
)
const reason = fc.constantFrom('requested_by_customer', 'damaged', '')
const notApplied = fc.constantFrom(
  'duplicate_capture_refunded',
  'order_cancelled_refunded',
  'amount_mismatch',
  'stock_unavailable',
)

/** One step of a generated history: a move the state machine allows, a further partial refund, or a stray capture. */
type Step =
  | { kind: 'move'; pick: number }
  | { kind: 'further-refund' }
  | { kind: 'not-applied'; reason: string }

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.nat({ max: 9 }).map((pick) => ({ kind: 'move' as const, pick })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'further-refund' as const }) },
  { weight: 2, arbitrary: notApplied.map((r) => ({ kind: 'not-applied' as const, reason: r })) },
)

/**
 * The rows a legal walk of the state machine writes, interleaved with not-applied captures, and the entries each row
 * must give. Timestamps are independent of row order, so an implementation that sorts by time is seen.
 */
const history = fc
  .tuple(fc.array(fc.tuple(step, timestamp, actor, reason), { maxLength: 14 }), timestamp, actor)
  .map(([steps, placedAt, placedBy]) => {
    const rows: Row[] = [
      {
        fromStatus: null,
        toStatus: 'pending',
        actor: placedBy,
        note: 'order draft created',
        timestamp: placedAt,
      },
    ]
    const expected: Array<{ kind: Kind; at: string }> = [{ kind: 'placed', at: placedAt }]
    let status: OrderStatus = 'pending'
    for (const [s, at, by, why] of steps) {
      if (s.kind === 'not-applied') {
        rows.push({
          fromStatus: status,
          toStatus: status,
          actor: 'system:checkout-finalize',
          note: `captured payment not applied: ${s.reason}`,
          timestamp: at,
        })
        continue
      }
      if (s.kind === 'further-refund') {
        if (status !== 'partially_refunded') continue
        rows.push({
          fromStatus: status,
          toStatus: status,
          actor: by,
          note: `${REFUND_NOTE_PREFIX}£4.20${why === '' ? '' : `: ${why}`}`,
          timestamp: at,
        })
        expected.push({ kind: 'partially_refunded', at })
        continue
      }
      const next: readonly OrderStatus[] = ORDER_STATUS_TRANSITIONS[status]
      if (next.length === 0) continue
      const to: OrderStatus = next[s.pick % next.length]!
      const note =
        to === 'refunded' || to === 'partially_refunded'
          ? `${REFUND_NOTE_PREFIX}£9.99${why === '' ? '' : `: ${why}`}`
          : to === 'shipped'
            ? 'Shipped via royal-mail: TRK-1'
            : to === 'cancelled'
              ? 'Cancelled by admin'
              : to === 'confirmed'
                ? 'payment captured'
                : ''
      rows.push({ fromStatus: status, toStatus: to, actor: by, note, timestamp: at })
      const kind = kindOfMove(status, to)
      if (kind !== null) expected.push({ kind, at })
      status = to
    }
    return { rows, expected }
  })

describe('AC-1: orderTimeline classifies order_history rows', () => {
  it('AC-1: property: over legal walks of the state machine interleaved with not-applied captures, each entry is one row’s lifecycle step with that row’s timestamp, in row order, carrying only kind and at', () => {
    fc.assert(
      fc.property(history, ({ rows, expected }) => {
        const before = JSON.stringify(rows)
        const timeline = orderTimeline(rows)
        expect(timeline).toEqual(expected)
        // Exact keys: an entry carrying the row's actor or note is not the timeline.
        expect(timeline.map((e: object) => Object.keys(e).sort())).toEqual(
          expected.map(() => ['at', 'kind']),
        )
        expect(JSON.stringify(rows), 'the rows are left as they were').toBe(before)
      }),
      { numRuns: 400 },
    )
  })

  it('AC-1: property: a stray capture at any status adds no entry, and a further partial refund adds exactly one partially_refunded, to the timeline of the same rows without it', () => {
    fc.assert(
      fc.property(history, timestamp, notApplied, (h, at, why) => {
        const status = h.rows[h.rows.length - 1]!.toStatus
        const stray: Row = {
          fromStatus: status,
          toStatus: status,
          actor: 'system:checkout-finalize',
          note: `captured payment not applied: ${why}`,
          timestamp: at,
        }
        expect(orderTimeline([...h.rows, stray])).toEqual(orderTimeline(h.rows))

        const further: Row = { ...stray, actor: 'admin:u-1', note: `${REFUND_NOTE_PREFIX}£1.00` }
        expect(orderTimeline([...h.rows, further])).toEqual(
          status === 'partially_refunded'
            ? [...orderTimeline(h.rows), { kind: 'partially_refunded', at }]
            : orderTimeline(h.rows),
        )
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: each row of the classification table gives its entry, and a move to processing or a same-status row of any other kind gives none', () => {
    const at = '2026-10-25T09:30:00.000Z'
    const row = (fromStatus: OrderStatus | null, toStatus: OrderStatus, note = ''): Row => ({
      fromStatus,
      toStatus,
      actor: 'admin:u-1',
      note,
      timestamp: at,
    })
    const cases: Array<[Row, Kind | null]> = [
      [row(null, 'pending', 'order draft created'), 'placed'],
      [row('pending', 'confirmed', 'payment captured'), 'paid'],
      [row('processing', 'shipped', 'Shipped via dpd: T-9'), 'shipped'],
      [row('shipped', 'delivered'), 'delivered'],
      [row('pending', 'cancelled', 'Cancelled by admin'), 'cancelled'],
      [row('confirmed', 'refunded', `${REFUND_NOTE_PREFIX}£12.00`), 'refunded'],
      [row('delivered', 'partially_refunded', `${REFUND_NOTE_PREFIX}£1.00`), 'partially_refunded'],
      [
        row('partially_refunded', 'partially_refunded', `${REFUND_NOTE_PREFIX}£2.00: damaged`),
        'partially_refunded',
      ],
      [row('confirmed', 'processing'), null],
      [row('shipped', 'shipped', 'captured payment not applied: duplicate_capture_refunded'), null],
      [
        row('cancelled', 'cancelled', 'captured payment not applied: order_cancelled_refunded'),
        null,
      ],
      [
        row(
          'partially_refunded',
          'partially_refunded',
          'captured payment not applied: duplicate_capture_refunded',
        ),
        null,
      ],
      [
        row('delivered', 'delivered', 'captured payment not applied: duplicate_capture_refunded'),
        null,
      ],
      [row('refunded', 'refunded', `${REFUND_NOTE_PREFIX}£2.00`), null],
    ]
    expect(cases.map(([r]) => orderTimeline([r]))).toEqual(
      cases.map(([, kind]) => (kind === null ? [] : [{ kind, at }])),
    )
  })
})
