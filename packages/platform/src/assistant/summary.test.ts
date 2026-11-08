import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  adminOrderArb,
  expectedOrderSummary,
  expectedProductSummary,
  productArb,
} from '../../tests/support/summaries.js'
import { kindOfKey } from '../customer-fields.js'
import { orderSummary, productSummary } from './summary.js'

// AC-6: the list summaries the assistant's model reads in place of whole orders and products. Each is the record's own
// fields under the record's own key names, so the shared mask rule (`kindOfKey`) reads a summary's customer values as
// it reads the order's, and nothing a shopper or an import wrote at length (notes, metadata, a description) rides along.

/** Every key at any depth of `value`. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysIn(child)])
}

const NEVER = [
  'addressLine1',
  'addressLine2',
  'phone',
  'lineItems',
  'notes',
  'metadata',
  'description',
]

describe('AC-6: an order or product summary is the record’s own fields, under its own key names', () => {
  it('AC-6: property: for any order, orderSummary deep-equals its number, status, createdAt, email, shipping first and last name, city, postcode and country, its own totalMinor, capturedMinor and refundedMinor (never the payment’s), keptMinor its own capturedMinor less refundedMinor, and itemCount the sum of its line quantities', () => {
    fc.assert(
      fc.property(adminOrderArb, (order) => {
        expect(orderSummary(order)).toEqual(expectedOrderSummary(order))
      }),
      { numRuns: 200 },
    )
  })

  it('AC-6: property: for any product with variants, productSummary deep-equals its id, slug, name, status and type and each variant’s id, name, sku, priceMinor, stock, status and options, in order', () => {
    fc.assert(
      fc.property(productArb, (product) => {
        expect(productSummary(product)).toEqual(expectedProductSummary(product))
      }),
      { numRuns: 200 },
    )
  })

  it('AC-6: property: every summary key holding one of the order’s customer values has the kindOfKey kind of the Order key it came from (email, firstName, lastName, postalCode), and no order or product summary holds addressLine1, phone, lineItems, notes, metadata or description at any depth', () => {
    fc.assert(
      fc.property(adminOrderArb, productArb, (order, product) => {
        const ship = order.shippingAddress
        // The customer values the order holds, each with the kind its own key gives it.
        const fromOrder = new Map<string, string | undefined>([
          [order.email, kindOfKey('email')],
          [ship.firstName, kindOfKey('firstName')],
          [ship.lastName, kindOfKey('lastName')],
          [ship.postalCode, kindOfKey('postalCode')],
          [ship.addressLine1, kindOfKey('addressLine1')],
          ...(ship.phone === undefined ? [] : [[ship.phone, kindOfKey('phone')] as const]),
        ])
        const others = [ship.city, ship.country, order.orderNumber, order.status, order.createdAt]
        fc.pre(others.every((v) => !fromOrder.has(v)) && ship.firstName !== ship.lastName)
        const summary = orderSummary(order) as Record<string, unknown>
        const held = Object.entries(summary).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && fromOrder.has(entry[1]),
        )

        expect(held.map(([key]) => [key, kindOfKey(key)])).toEqual(
          held.map(([key, value]) => [key, fromOrder.get(value)]),
        )
        expect(held.length).toBe(4)
        expect(keysIn(summary).filter((key) => NEVER.includes(key))).toEqual([])
        expect(keysIn(productSummary(product)).filter((key) => NEVER.includes(key))).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})

describe('AC-1: an order summary carries the money the order kept', () => {
  it('AC-1: property (money): for any listed order whose payment’s figures differ from its own, keptMinor is the order’s own capturedMinor less its own refundedMinor, never a payment figure or totalMinor, and the summary deep-equals the oracle with keptMinor', () => {
    fc.assert(
      fc.property(adminOrderArb, (order) => {
        const summary = orderSummary(order)

        expect(summary.keptMinor).toBe(order.capturedMinor - order.refundedMinor)
        expect(summary.keptMinor).toBe(summary.capturedMinor - summary.refundedMinor)
        expect(summary).toEqual(expectedOrderSummary(order))
      }),
      { numRuns: 200 },
    )
  })
})

describe('AC-2: a product summary carries its type and each variant’s options as stored', () => {
  it('AC-2: property: for any product, simple or variable whatever its variant count, with variants of 0-3 options each, the summary’s type is the product’s and each summary variant’s options deep-equal its source variant’s, variants in order, and no key the summaries exclude appears at any depth', () => {
    fc.assert(
      fc.property(productArb, (product) => {
        const summary = productSummary(product)

        expect(summary.type).toBe(product.type)
        expect(summary.variants.map((v) => [v.id, v.options])).toEqual(
          product.variants.map((v) => [v.id, v.options]),
        )
        expect(keysIn(summary).filter((key) => NEVER.includes(key))).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})
