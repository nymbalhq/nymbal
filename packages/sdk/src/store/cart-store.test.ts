import { describe, it, expect, vi } from 'vitest'
import { createCartStore } from './cart-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { Cart } from '@nymbal/types'

function makeCart(overrides?: Partial<Cart>): Cart {
  return {
    token: 'cart-1', customerId: null, items: [], subtotalMinor: 0,
    currency: 'GBP', expiresAt: '', createdAt: '', updatedAt: '',
    ...overrides,
  }
}

function makeAdapter(overrides?: Partial<CommerceAdapter['cart']>): CommerceAdapter {
  const cart: CommerceAdapter['cart'] = {
    get: vi.fn().mockResolvedValue(makeCart()),
    addItem: vi.fn().mockResolvedValue(makeCart({ items: [{ variantId: 'v1', productId: 'p1', productName: 'P', variantName: 'D', priceMinor: 1000, qty: 1, imageUrl: '' }], subtotalMinor: 1000, itemCount: 1 } as unknown as Partial<Cart>)),
    removeItem: vi.fn().mockResolvedValue(makeCart()),
    updateQuantity: vi.fn().mockResolvedValue(makeCart()),
    clear: vi.fn().mockResolvedValue(makeCart()),
    ...overrides,
  }
  return { cart } as unknown as CommerceAdapter
}

describe('CartStore', () => {
  it('initial state has empty items', () => {
    const store = createCartStore(makeAdapter())
    expect(store.getState().items).toEqual([])
    expect(store.getState().itemCount).toBe(0)
  })

  it('load calls adapter.cart.get and updates state', async () => {
    const adapter = makeAdapter({
      get: vi.fn().mockResolvedValue(makeCart({
        items: [{ variantId: 'v1', productId: 'p1', productName: 'P', variantName: 'D', priceMinor: 1000, qty: 2, imageUrl: '' }],
        subtotalMinor: 2000,
      })),
    })
    const store = createCartStore(adapter)
    await store.load()
    expect(store.getState().items).toHaveLength(1)
    expect(store.getState().subtotalMinor).toBe(2000)
    expect(store.getState().itemCount).toBe(2)
    expect(store.getState().loading).toBe(false)
  })

  it('load on adapter error sets error state', async () => {
    const adapter = makeAdapter({
      get: vi.fn().mockRejectedValue(new Error('network error')),
    })
    const store = createCartStore(adapter)
    await store.load()
    expect(store.getState().error).toBe('network error')
    expect(store.getState().loading).toBe(false)
  })

  it('addItem calls adapter and updates state', async () => {
    const adapter = makeAdapter()
    const store = createCartStore(adapter)
    await store.addItem('v1', 2)
    expect(adapter.cart.addItem).toHaveBeenCalledWith('v1', 2)
    expect(store.getState().loading).toBe(false)
  })

  it('addItem on error sets error state', async () => {
    const adapter = makeAdapter({
      addItem: vi.fn().mockRejectedValue(new Error('out of stock')),
    })
    const store = createCartStore(adapter)
    await store.addItem('v1')
    expect(store.getState().error).toBe('out of stock')
  })

  it('removeItem calls adapter and updates state', async () => {
    const adapter = makeAdapter()
    const store = createCartStore(adapter)
    await store.removeItem('v1')
    expect(adapter.cart.removeItem).toHaveBeenCalledWith('v1')
  })

  it('updateQuantity calls adapter', async () => {
    const adapter = makeAdapter()
    const store = createCartStore(adapter)
    await store.updateQuantity('v1', 3)
    expect(adapter.cart.updateQuantity).toHaveBeenCalledWith('v1', 3)
  })

  it('clear calls adapter and resets items', async () => {
    const adapter = makeAdapter()
    const store = createCartStore(adapter)
    await store.clear()
    expect(adapter.cart.clear).toHaveBeenCalled()
    expect(store.getState().items).toHaveLength(0)
  })

  it('subscribe listener is notified on state change', async () => {
    const adapter = makeAdapter()
    const store = createCartStore(adapter)
    const listener = vi.fn()
    store.subscribe(listener)
    await store.load()
    expect(listener).toHaveBeenCalled()
    store.destroy()
  })
})
