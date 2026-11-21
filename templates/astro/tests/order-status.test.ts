import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { OrderStatus, PaymentState } from '@nymbalhq/types'
import { isPaid, orderHeading } from '../src/lib/order-status'

// The order page's heading and paid flag, from the order's fulfilment status and its payment state.

interface OrderView {
  status: OrderStatus
  payment?: { state: PaymentState }
}

const headingOf = orderHeading as unknown as (order: OrderView) => string
const paidOf = isPaid as unknown as (order: OrderView) => boolean

const STATUSES: readonly OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]
const STATES: readonly PaymentState[] = ['unpaid', 'paid', 'partially_refunded', 'refunded']
const FULFILLED: readonly OrderStatus[] = ['confirmed', 'processing', 'shipped', 'delivered']

/** The page as it read before refunds came into it: only the status decides. */
const asToday = (status: OrderStatus): { heading: string; paid: boolean } =>
  FULFILLED.includes(status)
    ? { heading: 'Order confirmed', paid: true }
    : status === 'pending'
      ? { heading: 'Awaiting payment', paid: false }
      : { heading: `Order ${status}`, paid: false }

describe('the order page reads refunds from the payment state', () => {
  // Defect: a refunded order reads "Order confirmed" and paid, or a partial refund changes the heading.
  it('AC-17: property: over status × payment state: refunded reads "Order refunded" and not paid; partially_refunded reads the status heading and paid when confirmed through delivered; pending, cancelled and unpaid read as before; a missing payment reads as before', () => {
    const state = fc.option(fc.constantFrom(...STATES), { nil: undefined })
    fc.assert(
      fc.property(fc.constantFrom(...STATUSES), state, (status, s) => {
        const order: OrderView = s === undefined ? { status } : { status, payment: { state: s } }
        const shown = { heading: headingOf(order), paid: paidOf(order) }
        const expected =
          s === 'refunded' ? { heading: 'Order refunded', paid: false } : asToday(status)
        expect(shown, `${status}/${s}`).toEqual(expected)
      }),
      { numRuns: 200 },
    )
  })
})
