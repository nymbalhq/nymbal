import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ORDER_STATUS_TRANSITIONS,
  orderMovesFrom,
  statusBeforePartialRefund,
  type OrderStatus,
} from '../index.js'

// AC-1: a partially refunded order may move on to processing, shipped or delivered; no other move of the table
// changes. AC-2: what a partially refunded order may move to is narrowed by the status it was refunded at, read from
// its history, so fulfilment never goes backwards or repeats.

/** The table before partially refunded orders could move on, pinned here so every other row is held to it. */
const BEFORE: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled', 'refunded', 'partially_refunded'],
  processing: ['shipped', 'cancelled', 'refunded', 'partially_refunded'],
  shipped: ['delivered', 'refunded', 'partially_refunded'],
  delivered: ['refunded', 'partially_refunded'],
  cancelled: [],
  refunded: [],
  partially_refunded: ['refunded'],
}

const STATUSES = Object.keys(BEFORE) as OrderStatus[]
const FULFILMENT: readonly OrderStatus[] = ['processing', 'shipped', 'delivered']
/** Where each status stands in fulfilment: a move on never lands at or before where the order was refunded. */
const RANK: Partial<Record<OrderStatus, number>> = {
  confirmed: 0,
  processing: 1,
  shipped: 2,
  delivered: 3,
}
const REFUNDED_AT: readonly OrderStatus[] = ['confirmed', 'processing', 'shipped', 'delivered']

const asSet = (statuses: readonly OrderStatus[]): OrderStatus[] => [...new Set(statuses)].sort()

describe('AC-1: the transition table', () => {
  it('AC-1: every row but partially_refunded is the row it was, and partially_refunded’s row is its old row plus exactly processing, shipped and delivered', () => {
    expect(Object.keys(ORDER_STATUS_TRANSITIONS).sort()).toEqual([...STATUSES].sort())
    const rows = (table: Record<OrderStatus, readonly OrderStatus[]>) =>
      Object.fromEntries(STATUSES.map((s) => [s, asSet(table[s])]))
    expect(rows(ORDER_STATUS_TRANSITIONS)).toEqual(
      rows({ ...BEFORE, partially_refunded: [...BEFORE.partially_refunded, ...FULFILMENT] }),
    )
    expect(
      STATUSES.map((s) => ORDER_STATUS_TRANSITIONS[s].length),
      'no move listed twice',
    ).toEqual(STATUSES.map((s) => new Set(ORDER_STATUS_TRANSITIONS[s]).size))
    const added = STATUSES.flatMap((s) =>
      ORDER_STATUS_TRANSITIONS[s]
        .filter((to) => !BEFORE[s].includes(to))
        .map((to) => `${s} → ${to}`),
    )
    const removed = STATUSES.flatMap((s) =>
      BEFORE[s]
        .filter((to) => !ORDER_STATUS_TRANSITIONS[s].includes(to))
        .map((to) => `${s} → ${to}`),
    )
    expect({ added: added.sort(), removed }).toEqual({
      added: FULFILMENT.map((to) => `partially_refunded → ${to}`).sort(),
      removed: [],
    })
  })
})

type Row = { fromStatus: OrderStatus | null; toStatus: OrderStatus }

const status = fc.constantFrom(...STATUSES)
/** Rows biased towards moves into partially_refunded, from a fulfilment status, from itself or from nothing. */
const row: fc.Arbitrary<Row> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ fromStatus: status, toStatus: status }) },
  {
    weight: 3,
    arbitrary: fc.record({
      fromStatus: fc.constantFrom<OrderStatus | null>(...REFUNDED_AT, 'partially_refunded', null),
      toStatus: fc.constant<OrderStatus>('partially_refunded'),
    }),
  },
  { weight: 1, arbitrary: fc.record({ fromStatus: fc.constant(null), toStatus: status }) },
)
const history = fc.array(row, { maxLength: 12 })

/** A row that moved the order into partially_refunded from another status. */
const entersPartialRefund = (r: Row): boolean =>
  r.toStatus === 'partially_refunded' &&
  r.fromStatus !== null &&
  r.fromStatus !== 'partially_refunded'

describe('AC-2: the status an order was refunded at narrows its moves', () => {
  it('AC-2: property: statusBeforePartialRefund is the from status of the last row into partially_refunded from another status, null when none; a later such row decides it and any other row leaves it', () => {
    fc.assert(
      fc.property(history, row, (rows, next) => {
        const last = rows.findLastIndex(entersPartialRefund)
        const before = statusBeforePartialRefund(rows)
        expect(before).toBe(last < 0 ? null : rows[last]!.fromStatus)

        const extended = statusBeforePartialRefund([...rows, next])
        expect(extended).toBe(entersPartialRefund(next) ? next.fromStatus : before)
      }),
      { numRuns: 500 },
    )
  })

  it('AC-2: of two refunds into partially_refunded, the later one names the status (refunded at shipped, after an earlier one at confirmed)', () => {
    const rows: Row[] = [
      { fromStatus: null, toStatus: 'pending' },
      { fromStatus: 'pending', toStatus: 'confirmed' },
      { fromStatus: 'confirmed', toStatus: 'partially_refunded' },
      { fromStatus: 'partially_refunded', toStatus: 'partially_refunded' },
      { fromStatus: 'shipped', toStatus: 'partially_refunded' },
      { fromStatus: 'partially_refunded', toStatus: 'partially_refunded' },
    ]
    const first = statusBeforePartialRefund(rows.slice(0, 4))
    const last = statusBeforePartialRefund(rows)
    expect([first, last]).toEqual(['confirmed', 'shipped'])
    expect(first).not.toBe(last)
  })

  const before = fc.constantFrom<OrderStatus | null>(...STATUSES, null)

  it('AC-2: property: orderMovesFrom(s, b) is always within the table’s row for s, and is that row when s is not partially_refunded or b is null', () => {
    fc.assert(
      fc.property(status, before, (s, b) => {
        const moves: readonly OrderStatus[] = orderMovesFrom(s, b)
        const row = ORDER_STATUS_TRANSITIONS[s]
        expect(
          moves.filter((m) => !row.includes(m)),
          `${s} from ${b}: moves the table refuses`,
        ).toEqual([])
      }),
      { numRuns: 300 },
    )
    fc.assert(
      fc.property(
        fc.tuple(status, before).filter(([s, b]) => s !== 'partially_refunded' || b === null),
        ([s, b]) => {
          expect(asSet(orderMovesFrom(s, b)), `${s} from ${b}`).toEqual(
            asSet(ORDER_STATUS_TRANSITIONS[s]),
          )
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-2: property: refunded at a fulfilment status b, a partially refunded order may move to refunded and the fulfilment moves of b, every one after b', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REFUNDED_AT), (b) => {
        const moves: readonly OrderStatus[] = orderMovesFrom('partially_refunded', b)
        expect(asSet(moves), `refunded at ${b}`).toEqual(
          asSet(['refunded', ...ORDER_STATUS_TRANSITIONS[b].filter((m) => FULFILMENT.includes(m))]),
        )
        const onward = moves.filter((m) => FULFILMENT.includes(m))
        expect(
          onward.filter((m) => RANK[m]! <= RANK[b]!),
          `refunded at ${b}: moves that go backwards or repeat`,
        ).toEqual([])
      }),
      { numRuns: 50 },
    )
  })

  it('AC-2: refunded at confirmed, processing, shipped and delivered, a partially refunded order may move to processing, shipped, delivered and no fulfilment status respectively, and always to refunded', () => {
    const offered = REFUNDED_AT.map((b) => asSet(orderMovesFrom('partially_refunded', b)))
    expect(offered).toEqual([
      asSet(['processing', 'refunded']),
      asSet(['shipped', 'refunded']),
      asSet(['delivered', 'refunded']),
      ['refunded'],
    ])
    expect(asSet(orderMovesFrom('partially_refunded', null))).toEqual(
      asSet(ORDER_STATUS_TRANSITIONS.partially_refunded),
    )
  })
})
