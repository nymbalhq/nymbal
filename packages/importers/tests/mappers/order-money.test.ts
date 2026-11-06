import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mapOrder } from '../../src/woocommerce/mappers/order.js'
import type { WcOrder } from '../../src/woocommerce/client.js'
import {
  CURRENCIES,
  decimal,
  moneyDraft,
  orderMoney,
  sourceFigures,
  type Rec,
} from '../integration/support/wc-orders.js'

// What an imported order says it was charged: the order mapper over WooCommerce orders that add up (wc-orders.ts),
// in currencies with 0, 2 and 3 minor digits. The store's own currency is GBP throughout, so an amount read in the
// store's currency instead of the order's is caught.

const STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
]

function wcOrder(fields: Rec): WcOrder {
  const order: Rec = {
    id: 4242,
    number: '4242',
    status: 'completed',
    currency: 'GBP',
    date_created: '2024-02-01T12:00:00',
    customer_id: 0,
    billing: {
      first_name: '',
      last_name: '',
      company: '',
      address_1: '',
      address_2: '',
      city: '',
      state: '',
      postcode: '',
      country: 'GB',
      phone: '',
      email: 'buyer@example.com',
    },
    shipping: {
      first_name: '',
      last_name: '',
      company: '',
      address_1: '',
      address_2: '',
      city: '',
      state: '',
      postcode: '',
      country: '',
      phone: '',
    },
    line_items: [],
    shipping_lines: [],
    tax_lines: [],
    discount_total: '0',
    shipping_total: '0',
    total_tax: '0',
    total: '0',
    customer_note: '',
    meta_data: [],
    payment_method: 'stripe',
    ...fields,
  }
  return order as unknown as WcOrder
}

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)
const LINE_REFS = [
  { productId: 100, variationId: 0, sku: 'TEE-1' },
  { productId: 101, variationId: 0, sku: 'CAP-1' },
]

describe('AC-8: an imported order says what WooCommerce charged', () => {
  it("AC-8: for orders that add up in GBP, USD, JPY and KWD, the total is WooCommerce's, subtotal − discount + shipping + tax = total, the subtotal is the sum of the lines, line tax plus shipping tax is the tax total, each product line carries its total_tax, and each fee is one line", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        moneyDraft,
        fc.constantFrom(...STATUSES),
        (currency, draft, status) => {
          const wc = wcOrder({ currency, status, ...orderMoney(draft, currency, LINE_REFS) })
          const src = sourceFigures(wc as unknown as Rec, currency)
          const mapped = mapOrder(wc, null, { 100: 'p-100', 101: 'p-101' }, 'GBP')
          const isFee = (variantId: string) => variantId.startsWith('fee:')
          const lines = mapped.lineItems

          expect({
            total: mapped.totalMinor,
            identity:
              mapped.subtotalMinor -
              mapped.discountTotalMinor +
              mapped.shippingTotalMinor +
              mapped.taxTotalMinor,
            subtotal: mapped.subtotalMinor,
            tax: mapped.taxTotalMinor,
            productLineTaxes: lines.filter((l) => !isFee(l.variantId)).map((l) => l.lineTaxMinor),
            fees: lines.filter((l) => isFee(l.variantId)),
            payment:
              0 <= (mapped.refundedMinor ?? 0) &&
              (mapped.refundedMinor ?? 0) <= (mapped.capturedMinor ?? 0) &&
              (mapped.capturedMinor ?? 0) <= mapped.totalMinor,
          }).toEqual({
            total: src.total,
            identity: src.total,
            subtotal: sum(lines.map((l) => l.lineSubtotalMinor)),
            tax: sum(lines.map((l) => l.lineTaxMinor)) + src.shippingTax,
            productLineTaxes: src.lineTaxes,
            fees: src.fees.map((f) => ({
              productId: '',
              variantId: `fee:${f.id}`,
              productName: f.name,
              variantName: '',
              sku: '',
              qty: 1,
              unitPriceMinor: f.total,
              lineSubtotalMinor: f.total,
              lineTotalMinor: f.total,
              lineTaxMinor: f.tax,
              imageUrl: '',
            })),
            payment: true,
          })
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-8: a total of "1500" in JPY is 1500 minor units and "1.234" in KWD is 1234, whatever the store currency', () => {
    const jpy = mapOrder(wcOrder({ currency: 'JPY', total: '1500' }), null, {}, 'GBP')
    const kwd = mapOrder(wcOrder({ currency: 'KWD', total: '1.234' }), null, {}, 'GBP')

    expect([jpy.totalMinor, kwd.totalMinor]).toEqual([1500, 1234])
  })
})

describe('AC-11: partial refunds are kept', () => {
  const partlyRefunded = (status: string) =>
    wcOrder({
      status,
      total: '100.00',
      refunds: [
        { id: 1, reason: '', total: '-9.00' },
        { id: 2, reason: '', total: '-1.50' },
      ],
    })

  it('AC-11: a completed or processing order of 100.00 with refunds of 9.00 and 1.50 imports with 10000 captured and 1050 refunded, and a refunded one still refunds its whole total', () => {
    const outcome = ['completed', 'processing', 'refunded'].map((status) => {
      const mapped = mapOrder(partlyRefunded(status), null, {}, 'GBP')
      return [status, mapped.capturedMinor, mapped.refundedMinor]
    })

    expect(outcome).toEqual([
      ['completed', 10000, 1050],
      ['processing', 10000, 1050],
      ['refunded', 10000, 10000],
    ])
  })

  it('AC-11: refunds that add up to more than was captured are capped at the capture', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('completed', 'processing'),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 600_000 }), { minLength: 1, maxLength: 4 }),
        (status, totalMinor, refunds) => {
          const mapped = mapOrder(
            wcOrder({
              status,
              total: decimal(totalMinor, 'GBP'),
              refunds: refunds.map((r, i) => ({
                id: i + 1,
                reason: '',
                total: decimal(-r, 'GBP'),
              })),
            }),
            null,
            {},
            'GBP',
          )

          expect([mapped.capturedMinor, mapped.refundedMinor]).toEqual([
            totalMinor,
            Math.min(totalMinor, sum(refunds)),
          ])
        },
      ),
    )
  })
})
