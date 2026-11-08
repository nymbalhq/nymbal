import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ORDER_STATUS_TRANSITIONS,
  canRefund,
  fulfilmentMoves,
  type OrderStatus,
  type PaymentState,
} from '../index.js'

// The status says where the goods are and nothing else. The table's rows are pinned here; every other row a test
// reads through `fulfilmentMoves` is held to them.

const TABLE: Record<string, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
}

const STATUSES = Object.keys(TABLE) as OrderStatus[]
const PAYMENTS: readonly PaymentState[] = ['unpaid', 'paid', 'partially_refunded', 'refunded']
/** Where each status stands in the fulfilment order; cancelled stands after all of them and is terminal. */
const RANK: Record<string, number> = {
  pending: 0,
  confirmed: 1,
  processing: 2,
  shipped: 3,
  delivered: 4,
  cancelled: 5,
}

const asSet = (statuses: readonly OrderStatus[]): OrderStatus[] => [...new Set(statuses)].sort()
const status = fc.constantFrom(...STATUSES)
const payment = fc.constantFrom(...PAYMENTS)

describe('AC-1: the status table is fulfilment only', () => {
  // Defect: a money status or a money row survives, or a row loses or gains a move.
  it('AC-1: the table holds the six fulfilment statuses and exactly their moves, each listed once', () => {
    const table: Record<string, readonly string[]> = ORDER_STATUS_TRANSITIONS
    expect(Object.keys(table).sort()).toEqual([...STATUSES].sort())
    expect(
      Object.values(table)
        .flat()
        .filter((to) => !STATUSES.includes(to as OrderStatus)),
      'a move to a status that is not fulfilment',
    ).toEqual([])
    expect(
      Object.fromEntries(
        Object.entries(table).map(([from, row]) => [from, asSet(row as OrderStatus[])]),
      ),
    ).toEqual(Object.fromEntries(STATUSES.map((s) => [s, asSet(TABLE[s]!)])))
    expect(
      Object.values(table).map((row) => row.length),
      'no move listed twice',
    ).toEqual(Object.values(table).map((row) => new Set(row).size))
  })

  // Defect: a move goes backwards, repeats, or leaves cancelled.
  it('AC-1: property: every walk of the table goes strictly forward through the fulfilment order, cancelled is terminal, and no walk returns to a status it left', () => {
    fc.assert(
      fc.property(status, fc.array(fc.nat(), { maxLength: 8 }), (start, picks) => {
        const table: Record<string, readonly OrderStatus[]> = ORDER_STATUS_TRANSITIONS
        const walk: OrderStatus[] = [start]
        for (const pick of picks) {
          const from = walk.at(-1)!
          const row = table[from]
          expect(row, `the table has a row for ${from}`).toBeInstanceOf(Array)
          if (row!.length === 0) break
          walk.push(row![pick % row!.length]!)
        }
        for (let i = 1; i < walk.length; i += 1) {
          expect(STATUSES, `${walk.join(' → ')}: a move out of the fulfilment order`).toContain(walk[i])
          expect(RANK[walk[i]!]!, walk.join(' → ')).toBeGreaterThan(RANK[walk[i - 1]!]!)
        }
        expect(new Set(walk).size, walk.join(' → ')).toBe(walk.length)
        expect(walk.slice(0, -1), 'cancelled is terminal').not.toContain('cancelled')
      }),
      { numRuns: 400 },
    )
  })
})

describe('AC-2: a full refund closes fulfilment work, nothing else does', () => {
  const dropped: readonly OrderStatus[] = ['processing', 'shipped']

  // Defect: a full refund leaves fulfilment moves open, a partial one closes them, or a move outside the table is offered.
  it('AC-2: property: fulfilmentMoves is always within the table row, equals it unless the payment is refunded, and with refunded equals the row less processing and shipped', () => {
    fc.assert(
      fc.property(status, payment, (s, p) => {
        const moves = fulfilmentMoves(s, p)
        const row = TABLE[s]!
        expect(
          moves.filter((m: OrderStatus) => !row.includes(m)),
          `${s}/${p}: moves the table refuses`,
        ).toEqual([])
        expect(asSet(moves), `${s}/${p}`).toEqual(
          asSet(p === 'refunded' ? row.filter((m) => !dropped.includes(m)) : row),
        )
        expect(moves.length, `${s}/${p}: no move listed twice`).toBe(new Set(moves).size)
      }),
      { numRuns: 300 },
    )
  })

  // Defect: a shipped order that was fully refunded can never be delivered, though the parcel has left.
  it('AC-2: a fully refunded shipped order keeps its delivery, a fully refunded confirmed order may only be cancelled, and a fully refunded processing order may only be cancelled', () => {
    expect([
      fulfilmentMoves('shipped', 'refunded'),
      fulfilmentMoves('confirmed', 'refunded'),
      fulfilmentMoves('processing', 'refunded'),
    ]).toEqual([['delivered'], ['cancelled'], ['cancelled']])
  })

  // Defect: a refund is admitted on an order that never held goods to refund, or refused on one that did.
  it('AC-2: property: canRefund is true exactly for confirmed, processing, shipped and delivered', () => {
    const refundable: readonly OrderStatus[] = ['confirmed', 'processing', 'shipped', 'delivered']
    fc.assert(
      fc.property(status, (s) => {
        expect(canRefund(s), s).toBe(refundable.includes(s))
      }),
      { numRuns: 60 },
    )
  })
})
