import { describe, it, expect, beforeEach } from 'vitest'
import fc from 'fast-check'
import { seedRandom, resetRandom, createProduct, createOrder, createCart, createCustomer } from './index.js'

beforeEach(() => resetRandom())

describe('factory determinism', () => {
  it('produces identical output with same seed', () => {
    seedRandom(42)
    const a = createProduct()
    seedRandom(42)
    const b = createProduct()
    expect(a.id).toBe(b.id)
    expect(a.slug).toBe(b.slug)
  })

  it('produces different output with different seeds', () => {
    seedRandom(1)
    const a = createProduct()
    seedRandom(2)
    const b = createProduct()
    expect(a.id).not.toBe(b.id)
  })
})

describe('factory shapes', () => {
  it('createProduct returns required fields', () => {
    const p = createProduct()
    expect(p.id).toBeTruthy()
    expect(p.slug).toBeTruthy()
    expect(p.status).toBe('active')
  })

  it('createProduct overrides are applied', () => {
    const p = createProduct({ name: 'Custom Name', status: 'draft' })
    expect(p.name).toBe('Custom Name')
    expect(p.status).toBe('draft')
  })

  // Defect: an order whose total is not its lines plus shipping and tax less discount, which money assertions then trust.
  it('property: createOrder has consistent totals for any seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (seed) => {
        seedRandom(seed)
        const o = createOrder()
        const sum = (pick: (l: (typeof o.lineItems)[number]) => number) =>
          o.lineItems.reduce((acc, l) => acc + pick(l), 0)
        expect(o.subtotalMinor).toBe(sum((l) => l.lineSubtotalMinor))
        expect(o.taxTotalMinor).toBe(sum((l) => l.lineTaxMinor))
        expect(o.totalMinor).toBe(
          o.subtotalMinor + o.shippingTotalMinor + o.taxTotalMinor - o.discountTotalMinor,
        )
        expect(o.totalMinor).toBe(sum((l) => l.lineTotalMinor))
      }),
    )
  })

  it('createCart items sum matches subtotal', () => {
    const item = { variantId: 'v1', productId: 'p1', productName: 'P', variantName: 'D', priceMinor: 1000, qty: 3, imageUrl: '' }
    const cart = createCart({ items: [item], subtotalMinor: 3000 })
    const sum = cart.items.reduce((acc, i) => acc + i.priceMinor * i.qty, 0)
    expect(sum).toBe(cart.subtotalMinor)
  })

  it('createCustomer email is unique per instance', () => {
    const a = createCustomer()
    const b = createCustomer()
    expect(a.email).not.toBe(b.email)
  })
})
