import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { paymentState, refundableMinor, type Order, type OrderRefund } from '../index.js'

// AC-1: the payment state is a function of the stored amounts alone. AC-4: what is refundable counts pending refunds
// against the capture and ignores failed ones, so an unknown provider outcome cannot be refunded a second time.

function orderWith(capturedMinor: number, refundedMinor: number, totalMinor: number): Order {
  return {
    id: 'order-1',
    orderNumber: 'NYM-1001',
    sequence: 1000,
    customerId: null,
    status: capturedMinor > 0 ? 'confirmed' : 'pending',
    email: 'buyer@money.test',
    billingAddress: {
      firstName: 'Ada',
      lastName: 'Buyer',
      addressLine1: '1 Main St',
      city: 'London',
      region: 'England',
      postalCode: 'E1 6AN',
      country: 'GB',
    },
    shippingAddress: {
      firstName: 'Ada',
      lastName: 'Buyer',
      addressLine1: '1 Main St',
      city: 'London',
      region: 'England',
      postalCode: 'E1 6AN',
      country: 'GB',
    },
    lineItems: [],
    subtotalMinor: totalMinor,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor,
    currency: 'GBP',
    notes: '',
    metadata: {},
    // Every order has an intent from checkout start: it must not decide the state.
    paymentIntentId: 'pi_stub_any',
    capturedMinor,
    capturedAt: capturedMinor > 0 ? '2026-10-19T10:00:00.000Z' : null,
    refundedMinor,
    captureMethod: capturedMinor > 0 ? 'provider' : null,
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
  }
}

/** A captured amount and a refunded amount the invariant allows: 0 ≤ refunded ≤ captured ≤ total. */
const amounts = fc.integer({ min: 0, max: 5_000_000 }).chain((captured) =>
  fc.record({
    captured: fc.constant(captured),
    refunded: fc.oneof(
      fc.constant(0),
      fc.constant(captured),
      fc.integer({ min: 0, max: captured }),
    ),
    extra: fc.integer({ min: 0, max: 10_000 }),
  }),
)

describe('paymentState', () => {
  it('AC-1: over generated (captured, refunded) pairs exactly one of the four states holds, and paymentState returns it: unpaid when captured = 0, paid when refunded = 0 < captured, partially_refunded when 0 < refunded < captured, refunded when refunded = captured > 0', () => {
    fc.assert(
      fc.property(amounts, ({ captured, refunded, extra }) => {
        const holds = {
          unpaid: captured === 0,
          paid: refunded === 0 && captured > 0,
          partially_refunded: refunded > 0 && refunded < captured,
          refunded: refunded === captured && captured > 0,
        }
        const holding = Object.entries(holds).filter(([, h]) => h)
        expect(holding).toHaveLength(1)

        const state = paymentState(orderWith(captured, refunded, captured + extra))
        expect(state).toBe(holding[0]![0])
      }),
      { numRuns: 500 },
    )
  })

  it('AC-1: the state reads the stored amounts alone: the same amounts give the same state whatever the status and intent say', () => {
    fc.assert(
      fc.property(
        amounts,
        fc.constantFrom(
          'pending',
          'confirmed',
          'processing',
          'shipped',
          'delivered',
          'cancelled',
          'refunded',
          'partially_refunded',
        ),
        fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
        ({ captured, refunded, extra }, status, intent) => {
          const base = orderWith(captured, refunded, captured + extra)
          const relabelled: Order = { ...base, status, paymentIntentId: intent }
          expect(paymentState(relabelled)).toBe(paymentState(base))
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('refundableMinor', () => {
  const refundStatus = fc.constantFrom('pending', 'succeeded', 'failed')

  it('AC-4: refundable = captured − Σ succeeded − Σ pending, failed refunds never count, so a pending (unknown) refund is held against the capture', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ amountMinor: fc.integer({ min: 1, max: 5_000 }), status: refundStatus }),
          { maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 50_000 }),
        (rows, spare) => {
          const sum = (status: string) =>
            rows.filter((r) => r.status === status).reduce((s, r) => s + r.amountMinor, 0)
          const succeeded = sum('succeeded')
          const pending = sum('pending')
          const captured = succeeded + pending + spare
          const order = orderWith(captured, succeeded, captured)
          const refunds: OrderRefund[] = rows.map((r, i) => ({
            id: `refund-${i}`,
            orderId: order.id,
            amountMinor: r.amountMinor,
            currency: 'GBP',
            providerRefundId: `re_${i}`,
            status: r.status,
            reason: 'requested by the buyer',
            actor: 'admin:test',
            createdAt: '2026-10-19T11:00:00.000Z',
          }))

          expect(refundableMinor(order, refunds)).toBe(captured - succeeded - pending)
          expect(refundableMinor(order, refunds)).toBe(spare)
        },
      ),
      { numRuns: 300 },
    )
  })
})
