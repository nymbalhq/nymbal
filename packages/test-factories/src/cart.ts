import type { Cart, CartItem } from '@nymbal/types'
import { nextId, isoDate, randInt } from './prng.js'

export function createCartItem(overrides?: Partial<CartItem>): CartItem {
  const variantId = nextId()
  return {
    variantId,
    productId: nextId(),
    productName: `Product ${variantId.slice(0, 6)}`,
    variantName: 'Default',
    priceMinor: randInt(500, 5000),
    qty: randInt(1, 3),
    imageUrl: '',
    ...overrides,
  }
}

export function createCart(overrides?: Partial<Cart>): Cart {
  const item = createCartItem()
  return {
    token: nextId(),
    customerId: null,
    items: [item],
    subtotalMinor: item.priceMinor * item.qty,
    currency: 'GBP',
    expiresAt: isoDate(7),
    createdAt: isoDate(),
    updatedAt: isoDate(),
    ...overrides,
  }
}
