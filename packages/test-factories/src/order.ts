import type { Address, Order, OrderLineItem, OrderStatus } from '@nymbal/types'
import { nextId, isoDate, randInt } from './prng.js'

export function createAddress(overrides?: Partial<Address>): Address {
  return {
    firstName: 'Jane',
    lastName: 'Doe',
    addressLine1: '123 Test Street',
    city: 'London',
    region: 'England',
    postalCode: 'SW1A 1AA',
    country: 'GB',
    ...overrides,
  }
}

export function createLineItem(overrides?: Partial<OrderLineItem>): OrderLineItem {
  const variantId = nextId()
  const unitPrice = randInt(500, 5000)
  const qty = randInt(1, 3)
  return {
    variantId,
    productId: nextId(),
    productName: `Product ${variantId.slice(0, 6)}`,
    variantName: 'Default',
    sku: `SKU-${variantId.slice(0, 6).toUpperCase()}`,
    qty,
    unitPriceMinor: unitPrice,
    lineSubtotalMinor: unitPrice * qty,
    lineTaxMinor: Math.round(unitPrice * qty * 0.2),
    lineTotalMinor: Math.round(unitPrice * qty * 1.2),
    imageUrl: '',
    ...overrides,
  }
}

export function createOrder(overrides?: Partial<Order>): Order {
  const id = nextId()
  const seq = randInt(1000, 9999)
  const addr = createAddress()
  const line = createLineItem()
  return {
    id,
    orderNumber: `ORD-${seq}`,
    sequence: seq,
    customerId: null,
    status: 'pending' as OrderStatus,
    email: 'test@example.com',
    billingAddress: addr,
    shippingAddress: addr,
    lineItems: [line],
    subtotalMinor: line.lineSubtotalMinor,
    taxTotalMinor: line.lineTaxMinor,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: line.lineTotalMinor,
    currency: 'GBP',
    notes: '',
    metadata: {},
    paymentIntentId: null,
    createdAt: isoDate(),
    updatedAt: isoDate(),
    ...overrides,
  }
}
