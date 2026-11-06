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

  it('maps WC pending to pending', () => {
    expect(mapOrder(makeOrder({ status: 'pending' }), null, {}, 'GBP').status).toBe('pending')
  })

  it('carries a billing address line by line, filling an empty street, city or country', () => {
    const billing = {
      ...makeOrder().billing,
      address_1: '',
      address_2: 'Unit 4',
      city: '',
      country: '',
      company: 'Acme Ltd',
    }
    const result = mapOrder(makeOrder({ billing }), null, {}, 'GBP')
    expect(result.billingAddress).toEqual({
      firstName: 'Alice',
      lastName: 'Smith',
      addressLine1: '—',
      addressLine2: 'Unit 4',
      city: '—',
      region: 'England',
      postalCode: 'E1 6AN',
      country: 'US',
      phone: '07700900000',
      company: 'Acme Ltd',
    })
  })

  it('keeps a given street and leaves out an empty second line, phone and company', () => {
    const shipping = { ...makeOrder().shipping, address_2: '', phone: '', company: '' }
    const result = mapOrder(makeOrder({ shipping }), null, {}, 'GBP')
    expect(result.shippingAddress.addressLine1).toBe('2 Ship St')
    expect(
      Object.keys(result.shippingAddress).filter((k) =>
        ['addressLine2', 'phone', 'company'].includes(k),
      ),
    ).toEqual([])
  })

  it('links a line to the variation it bought, or to the product of a simple one, and marks an unmapped one unknown', () => {
    const line = makeOrder().line_items[0]!
    const result = mapOrder(
      makeOrder({
        line_items: [
          { ...line, id: 1, product_id: 100, variation_id: 501 },
          { ...line, id: 2, product_id: 100, variation_id: 0 },
          { ...line, id: 3, product_id: 300, variation_id: 0 },
        ],
      }),
      null,
      { 100: 'product-100' },
      'GBP',
      { variantIds: { 501: 'variant-501', 100: 'variant-of-100' } },
    )
    expect(result.lineItems.map((l) => [l.variantId, l.productId, l.imageUrl])).toEqual([
      ['variant-501', 'product-100', ''],
      ['variant-of-100', 'product-100', ''],
      ['unknown', 'unknown', ''],
    ])
  })

  it('has one line per product line when the order lists no fees', () => {
    const order = makeOrder()
    delete order.fee_lines
    expect(mapOrder(order, null, {}, 'GBP').lineItems).toHaveLength(order.line_items.length)
  })

  it('names a buyer with no billing email by the order id', () => {
    const billing = { ...makeOrder().billing }
    delete billing.email
    expect(mapOrder(makeOrder({ id: 31, billing }), null, {}, 'GBP').email).toBe(
      'wc-31@unknown.nymbal.local',
    )
  })

  it('captures nothing for a free completed order, and refunds nothing on a paid one that lists no refunds', () => {
    const free = mapOrder(makeOrder({ total: '0.00' }), null, {}, 'GBP')
    expect('capturedMinor' in free).toBe(false)
    const order = makeOrder({ status: 'processing' })
    delete order.refunds
    const paid = mapOrder(order, null, {}, 'GBP')
    expect(paid.capturedMinor).toBe(paid.totalMinor)
    expect(paid.refundedMinor).toBe(0)
    expect(paid.refundedMinor!).toBeLessThanOrEqual(paid.capturedMinor!)
  })

  it('keeps the customer note', () => {
    expect(mapOrder(makeOrder({ customer_note: 'Leave by the door' }), null, {}, 'GBP').notes).toBe(
      'Leave by the door',
    )
  })
})
