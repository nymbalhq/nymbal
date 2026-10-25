import { describe, it, expect, vi } from 'vitest'
import { createCartStore } from './cart-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { Cart } from '@nymbalhq/types'

function makeCart(overrides?: Partial<Cart>): Cart {
  return {
    token: 'cart-1',
    customerId: null,
    items: [],
    subtotalMinor: 0,
    currency: 'GBP',
    expiresAt: '',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function makeAdapter(overrides?: Partial<CommerceAdapter['cart']>): CommerceAdapter {
  const cart: CommerceAdapter['cart'] = {
    get: vi.fn().mockResolvedValue(makeCart()),
    addItem: vi.fn().mockResolvedValue(
      makeCart({
        items: [
          {
            variantId: 'v1',
            productId: 'p1',
            productName: 'P',
            variantName: 'D',
            priceMinor: 1000,
            qty: 1,
            imageUrl: '',
          },
        ],
        subtotalMinor: 1000,
        itemCount: 1,
      } as unknown as Partial<Cart>),
    ),
    removeItem: vi.fn().mockResolvedValue(makeCart()),
    updateQuantity: vi.fn().mockResolvedValue(makeCart()),
    clear: vi.fn().mockResolvedValue(makeCart()),
    ...overrides,
  }
  return { cart } as unknown as CommerceAdapter
}

describe('CartStore', () => {
  it('load calls adapter.cart.get and updates state', async () => {
    const adapter = makeAdapter({
      get: vi.fn().mockResolvedValue(
        makeCart({
          items: [
            {
              variantId: 'v1',
              productId: 'p1',
              productName: 'P',
              variantName: 'D',
              priceMinor: 1000,
              qty: 2,
              imageUrl: '',
            },
          ],
          subtotalMinor: 2000,
        }),
      ),
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

  it('removeItem leaves the cart the adapter answers, one line fewer, with the item count of its lines', async () => {
    const line = (variantId: string, qty: number) => ({
      variantId,
      productId: 'p1',
      productName: 'P',
      variantName: 'D',
      priceMinor: 1000,
      qty,
      imageUrl: '',
    })
    const adapter = makeAdapter({
      get: vi.fn().mockResolvedValue(makeCart({ items: [line('v1', 1), line('v2', 2)] })),
      removeItem: vi.fn(async (variantId: string) =>
        makeCart({
          items: [line('v1', 1), line('v2', 2)].filter((l) => l.variantId !== variantId),
        }),
      ),
    })
    const store = createCartStore(adapter)
    await store.load()
    const before = store.getState().items.length
    await store.removeItem('v1')
    expect(store.getState().items.map((l) => l.variantId)).toEqual(['v2'])
    expect(store.getState().items.length).toBe(before - 1)
    expect(store.getState().itemCount).toBe(2)
  })

  it('updateQuantity leaves the line at the quantity the adapter answers, and the item count follows it', async () => {
    const adapter = makeAdapter({
      updateQuantity: vi.fn(async (variantId: string, qty: number) =>
        makeCart({
          items: [
            {
              variantId,
              productId: 'p1',
              productName: 'P',
              variantName: 'D',
              priceMinor: 1000,
              qty,
              imageUrl: '',
            },
          ],
        }),
      ),
    })
    const store = createCartStore(adapter)
    await store.updateQuantity('v1', 3)
    expect(store.getState().items.map((l) => [l.variantId, l.qty])).toEqual([['v1', 3]])
    expect(store.getState().itemCount).toBe(
      store.getState().items.reduce((sum, l) => sum + l.qty, 0),
    )
  })

  it('clear calls adapter and resets items', async () => {
    const adapter = makeAdapter()
    const store = createCartStore(adapter)
    await store.clear()
    expect(adapter.cart.clear).toHaveBeenCalled()
    expect(store.getState().items).toHaveLength(0)
  })

  it('a subscriber reads the loaded cart when it is notified', async () => {
    const adapter = makeAdapter({
      get: vi.fn().mockResolvedValue(
        makeCart({
          items: [
            {
              variantId: 'v1',
              productId: 'p1',
              productName: 'P',
              variantName: 'D',
              priceMinor: 1000,
              qty: 2,
              imageUrl: '',
            },
          ],
          subtotalMinor: 2000,
        }),
      ),
    })
    const store = createCartStore(adapter)
    const seen: number[] = []
    store.subscribe(() => seen.push(store.getState().itemCount))
    await store.load()
    expect(seen[seen.length - 1]).toBe(2)
    store.destroy()
  })

  it('round-trip: addItem then removeItem returns cart to empty state', async () => {
    const cartWithItem = makeCart({
      items: [
        {
          variantId: 'v1',
          productId: 'p1',
          productName: 'P',
          variantName: 'D',
          priceMinor: 1000,
          qty: 1,
          imageUrl: '',
        },
      ],
      subtotalMinor: 1000,
    })
    const emptyCart = makeCart({ items: [], subtotalMinor: 0 })

    const adapter = makeAdapter({
      get: vi.fn().mockResolvedValue(emptyCart),
      addItem: vi.fn().mockResolvedValue(cartWithItem),
      removeItem: vi.fn().mockResolvedValue(emptyCart),
    })

    const store = createCartStore(adapter)
    await store.load()

    // Initial state: empty cart
    expect(store.getState().items).toHaveLength(0)
    expect(store.getState().subtotalMinor).toBe(0)

    // Add item
    await store.addItem('v1', 1)
    expect(store.getState().items).toHaveLength(1)
    expect(store.getState().subtotalMinor).toBe(1000)
    expect(store.getState().loading).toBe(false)

    // Remove item — should return to original empty state
    await store.removeItem('v1')
    expect(store.getState().items).toHaveLength(0)
    expect(store.getState().subtotalMinor).toBe(0)
    expect(store.getState().loading).toBe(false)
    expect(store.getState().error).toBeNull()
  })
})
