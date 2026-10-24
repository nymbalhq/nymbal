import { describe, it, expect } from 'vitest'
import { mapOrder } from '../../src/woocommerce/mappers/order.js'
import type { WcOrder } from '../../src/woocommerce/client.js'

function makeOrder(overrides: Partial<WcOrder> = {}): WcOrder {
  return {
    id: 1000,
    number: '1000',
    status: 'completed',
    currency: 'GBP',
    date_created: '2024-01-15T10:00:00',
    customer_id: 1,
    billing: {
      first_name: 'Alice', last_name: 'Smith', company: '',
      address_1: '1 Main St', address_2: '', city: 'London',
      state: 'England', postcode: 'E1 6AN', country: 'GB',
      phone: '07700900000', email: 'alice@example.com',
    },
    shipping: {
      first_name: 'Alice', last_name: 'Smith', company: '',
      address_1: '2 Ship St', address_2: '', city: 'Manchester',
      state: 'England', postcode: 'M1 1AA', country: 'GB', phone: '',
    },
    line_items: [
      { id: 1, product_id: 100, variation_id: 0, name: 'White Tee', quantity: 2, price: 29.99, subtotal: '59.98', total: '59.98', sku: 'WT-001' },
    ],
    shipping_lines: [{ method_title: 'Standard', total: '5.00' }],
    tax_lines: [{ label: 'VAT', tax_total: '13.00' }],
    discount_total: '0.00',
    shipping_total: '5.00',
    total_tax: '13.00',
    total: '77.98',
    customer_note: '',
    meta_data: [],
    payment_method: 'stripe',
    ...overrides,
  }
}

describe('mapOrder', () => {
  const productIdMap = { 100: 'nymbal-product-abc' }

  it('maps order number with WC- prefix', () => {
    const result = mapOrder(makeOrder(), 'nymbal-customer-xyz', productIdMap, 'GBP')
    expect(result.orderNumber).toBe('WC-1000')
  })

  it('maps WC completed status to delivered', () => {
    const result = mapOrder(makeOrder({ status: 'completed' }), null, {}, 'GBP')
    expect(result.status).toBe('delivered')
  })

  it('maps WC processing status to processing', () => {
    const result = mapOrder(makeOrder({ status: 'processing' }), null, {}, 'GBP')
    expect(result.status).toBe('processing')
  })

  it('maps WC on-hold status to pending', () => {
    const result = mapOrder(makeOrder({ status: 'on-hold' }), null, {}, 'GBP')
    expect(result.status).toBe('pending')
  })

  it('maps WC cancelled to cancelled', () => {
    const result = mapOrder(makeOrder({ status: 'cancelled' }), null, {}, 'GBP')
    expect(result.status).toBe('cancelled')
  })

  it('maps WC refunded to refunded', () => {
    const result = mapOrder(makeOrder({ status: 'refunded' }), null, {}, 'GBP')
    expect(result.status).toBe('refunded')
  })

  it('maps WC failed to cancelled', () => {
    const result = mapOrder(makeOrder({ status: 'failed' }), null, {}, 'GBP')
    expect(result.status).toBe('cancelled')
  })

  it('converts price strings to minor units', () => {
    const result = mapOrder(makeOrder(), 'cust-id', productIdMap, 'GBP')
    expect(result.totalMinor).toBe(7798)
    expect(result.shippingTotalMinor).toBe(500)
    expect(result.taxTotalMinor).toBe(1300)
  })

  it('maps line item field names to Nymbal shape', () => {
    const result = mapOrder(makeOrder(), null, productIdMap, 'GBP')
    const li = result.lineItems[0]!
    expect(li.qty).toBe(2)
    expect(li.productName).toBe('White Tee')
    expect(li.unitPriceMinor).toBe(2999)
  })

  it('maps billing address', () => {
    const result = mapOrder(makeOrder(), null, {}, 'GBP')
    expect(result.billingAddress.city).toBe('London')
    expect(result.billingAddress.country).toBe('GB')
  })

  it('uses separate shipping address when available', () => {
    const result = mapOrder(makeOrder(), null, {}, 'GBP')
    expect(result.shippingAddress.city).toBe('Manchester')
  })

  it('falls back to billing address when shipping is empty', () => {
    const result = mapOrder(
      makeOrder({ shipping: { ...makeOrder().shipping, address_1: '' } }),
      null,
      {},
      'GBP',
    )
    expect(result.shippingAddress.city).toBe('London')
  })

  it('stores original WC order id in metadata', () => {
    const result = mapOrder(makeOrder({ id: 9999 }), null, {}, 'GBP')
    const meta = result.metadata?.['woocommerce'] as Record<string, unknown>
    expect(meta['orderId']).toBe(9999)
    expect(meta['originalStatus']).toBe('completed')
  })

  it('uses createdAt from WC date', () => {
    const result = mapOrder(makeOrder(), null, {}, 'GBP')
    expect(result.createdAt.toISOString()).toContain('2024-01-15')
  })
})
