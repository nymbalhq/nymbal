import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { paymentState, type Order } from '@nymbalhq/types'
import { mapOrder } from '../../src/woocommerce/mappers/order.js'
import type { WcOrder } from '../../src/woocommerce/client.js'

// P1-13 AC-12 (decision 2): a WooCommerce order whose status implies payment (processing, completed, refunded) imports
// with a capture of its total and capture method `import`; refunded imports a refund equal to that capture; every other
// status imports with nothing captured. Kills: imported paid orders reading Unpaid (no capture mapped), a refunded
// import reading Paid (no refund mapped), and an unpaid status (pending, on-hold, cancelled, failed) mapped as paid.

const PAID = ['processing', 'completed', 'refunded'] as const
const UNPAID = ['pending', 'on-hold', 'cancelled', 'failed'] as const

function wcOrder(status: string, total: string): WcOrder {
  return {
    id: 2000,
    number: '2000',
    status,
    currency: 'GBP',
    date_created: '2024-03-01T10:00:00',
    customer_id: 1,
    billing: {
      first_name: 'Alice',
      last_name: 'Smith',
      company: '',
      address_1: '1 Main St',
      address_2: '',
      city: 'London',
      state: 'England',
      postcode: 'E1 6AN',
      country: 'GB',
      phone: '',
      email: 'alice@example.com',
    },
    shipping: {
      first_name: 'Alice',
      last_name: 'Smith',
      company: '',
      address_1: '1 Main St',
      address_2: '',
      city: 'London',
      state: 'England',
      postcode: 'E1 6AN',
      country: 'GB',
      phone: '',
    },
    line_items: [
      {
        id: 1,
        product_id: 100,
        variation_id: 0,
        name: 'White Tee',
        quantity: 1,
        price: Number(total),
        subtotal: total,
        total,
        sku: 'WT-001',
      },
    ],
    shipping_lines: [],
    tax_lines: [],
    discount_total: '0.00',
    shipping_total: '0.00',
    total_tax: '0.00',
    total,
    customer_note: '',
    meta_data: [],
    payment_method: 'stripe',
  }
}

/** A WooCommerce money string with two decimals, from 0.01 to 99,999.99. */
const wcTotal = fc.integer({ min: 1, max: 9_999_999 }).map((minor) => (minor / 100).toFixed(2))

/** The mapped import as the order it becomes, for `paymentState`. */
function asOrder(mapped: ReturnType<typeof mapOrder>): Order {
  return {
    id: mapped.orderId,
    orderNumber: mapped.orderNumber,
    sequence: 0,
    customerId: mapped.customerId,
    status: mapped.status,
    email: mapped.email,
    billingAddress: mapped.billingAddress,
    shippingAddress: mapped.shippingAddress,
    lineItems: mapped.lineItems,
    subtotalMinor: mapped.subtotalMinor,
    taxTotalMinor: mapped.taxTotalMinor,
    shippingTotalMinor: mapped.shippingTotalMinor,
    discountTotalMinor: mapped.discountTotalMinor,
    totalMinor: mapped.totalMinor,
    currency: mapped.currency,
    notes: mapped.notes ?? '',
    metadata: mapped.metadata ?? {},
    paymentIntentId: mapped.paymentIntentId ?? null,
    capturedMinor: mapped.capturedMinor ?? 0,
    capturedAt: null,
    refundedMinor: mapped.refundedMinor ?? 0,
    captureMethod: mapped.captureMethod ?? null,
    createdAt: mapped.createdAt.toISOString(),
    updatedAt: mapped.createdAt.toISOString(),
  }
}

describe('mapOrder: payment', () => {
  it('AC-12: processing and completed map to a capture of the total with capture method import and nothing refunded, and read Paid', () => {
    fc.assert(
      fc.property(fc.constantFrom('processing', 'completed'), wcTotal, (status, total) => {
        const mapped = mapOrder(wcOrder(status, total), null, { 100: 'p-1' }, 'GBP')
        expect(mapped.capturedMinor).toBe(mapped.totalMinor)
        expect(mapped.totalMinor).toBe(Math.round(Number(total) * 100))
        expect(mapped.refundedMinor ?? 0).toBe(0)
        expect(mapped.captureMethod).toBe('import')
        expect(paymentState(asOrder(mapped))).toBe('paid')
      }),
      { numRuns: 100 },
    )
  })

  it('AC-12: refunded maps to a capture of the total and a refund equal to it, with capture method import, and reads Refunded', () => {
    fc.assert(
      fc.property(wcTotal, (total) => {
        const mapped = mapOrder(wcOrder('refunded', total), null, { 100: 'p-1' }, 'GBP')
        expect(mapped.capturedMinor).toBe(mapped.totalMinor)
        expect(mapped.refundedMinor).toBe(mapped.capturedMinor)
        expect(mapped.captureMethod).toBe('import')
        expect(paymentState(asOrder(mapped))).toBe('refunded')
      }),
      { numRuns: 100 },
    )
  })

  it('AC-12: pending, on-hold, cancelled and failed map to nothing captured, nothing refunded and no capture method, and read Unpaid', () => {
    fc.assert(
      fc.property(fc.constantFrom(...UNPAID), wcTotal, (status, total) => {
        const mapped = mapOrder(wcOrder(status, total), null, { 100: 'p-1' }, 'GBP')
        expect(mapped.capturedMinor ?? 0).toBe(0)
        expect(mapped.refundedMinor ?? 0).toBe(0)
        expect(mapped.captureMethod ?? null).toBeNull()
        expect(paymentState(asOrder(mapped))).toBe('unpaid')
      }),
      { numRuns: 100 },
    )
  })

  it('AC-12: every paid status captures exactly the total: capturedMinor − refundedMinor is the total for processing and completed and 0 for refunded', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAID), wcTotal, (status, total) => {
        const mapped = mapOrder(wcOrder(status, total), null, { 100: 'p-1' }, 'GBP')
        const net = (mapped.capturedMinor ?? 0) - (mapped.refundedMinor ?? 0)
        expect(net).toBe(status === 'refunded' ? 0 : mapped.totalMinor)
      }),
      { numRuns: 100 },
    )
  })
})
