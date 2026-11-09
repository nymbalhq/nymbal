import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { canTransitionOrder, fulfilmentMoves, paymentState } from '@nymbalhq/types'
import type { OrderStatus } from '@nymbalhq/types'
import type { AdminOrder } from '@/types'
import { planOrderBulk } from './order-bulk'

// The plan is judged against the shared move table. A row has no `payment` here, as a row a realtime event placed has
// none: only the stored amounts can be read.

const STATUSES: OrderStatus[] = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']

const amounts = fc.oneof(
  fc.constant({ capturedMinor: 0, refundedMinor: 0 }),
  fc.integer({ min: 1, max: 1_000_000 }).chain((capturedMinor) =>
    fc.oneof(
      fc.constant({ capturedMinor, refundedMinor: 0 }),
      fc.constant({ capturedMinor, refundedMinor: capturedMinor }),
      fc.integer({ min: 1, max: capturedMinor }).map((refundedMinor) => ({ capturedMinor, refundedMinor })),
    ),
  ),
)

const orders = fc
  .array(fc.tuple(fc.constantFrom(...STATUSES), amounts), { maxLength: 30 })
  .map((rows) =>
    rows.map(
      ([status, money], i) =>
        ({ id: `o-${i}`, orderNumber: `NYM-${i}`, status, ...money }) as unknown as AdminOrder,
    ),
  )

interface Plan {
  eligible: AdminOrder[]
  skipped: Array<{ order: AdminOrder; reason: string }>
}

const moves = (order: AdminOrder) => fulfilmentMoves(order.status, paymentState(order))
const ids = (list: readonly AdminOrder[]) => list.map((o) => o.id)

describe('planOrderBulk', () => {
  it('AC-1: cancel splits every order into eligible or skipped in input order, eligible only if the table allows it and nothing was captured, and a captured order is skipped as paid', () => {
    fc.assert(
      fc.property(orders, (input) => {
        const allowed = (o: AdminOrder) => moves(o).includes('cancelled') && o.capturedMinor === 0
        const plan: Plan = planOrderBulk('cancel', input)
        const left = input.filter((o) => !allowed(o))

        expect(ids(plan.eligible)).toEqual(ids(input.filter(allowed)))
        expect(plan.skipped.map((s) => s.order.id)).toEqual(ids(left))
        expect(plan.skipped.map((s) => s.reason)).toEqual(
          left.map((o) => (o.capturedMinor > 0 ? 'paid' : 'status')),
        )
        expect(plan.eligible.length + plan.skipped.length).toBe(input.length)
        expect(plan.eligible.filter((o) => o.capturedMinor > 0)).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  it('AC-2: process splits every order the same way, eligible only if the table allows processing, a confirmed order left behind is skipped as refunded and any other as status', () => {
    fc.assert(
      fc.property(orders, (input) => {
        const allowed = (o: AdminOrder) => moves(o).includes('processing')
        const plan: Plan = planOrderBulk('process', input)
        const left = input.filter((o) => !allowed(o))

        expect(ids(plan.eligible)).toEqual(ids(input.filter(allowed)))
        expect(plan.skipped.map((s) => s.order.id)).toEqual(ids(left))
        expect(plan.skipped.map((s) => s.reason)).toEqual(
          left.map((o) => (o.status === 'confirmed' ? 'refunded' : 'status')),
        )
        expect(plan.eligible.length + plan.skipped.length).toBe(input.length)
        for (const order of plan.eligible) {
          expect(canTransitionOrder(order.status, 'processing')).toBe(true)
          expect(paymentState(order)).not.toBe('refunded')
        }
      }),
      { numRuns: 300 },
    )
  })
})
