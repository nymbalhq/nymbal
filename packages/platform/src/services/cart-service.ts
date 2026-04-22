import { v7 as uuidv7 } from 'uuid'
import {
  EVT_CART_CREATED,
  EVT_CART_ITEM_ADDED,
  EVT_CART_ITEM_REMOVED,
  EVT_CART_UPDATED,
  NotFoundError,
  ValidationError,
  type Cart,
  type CartItem,
  type DocumentStoreAdapter,
  type Logger,
} from '@nymbal/types'
import type { EventPublisher } from '../events/publisher.js'

const COLLECTION = 'carts'
const TTL_SECONDS_DEFAULT = 60 * 60 * 24 * 30

export interface CartService {
  getOrCreate(token?: string, customerId?: string | null): Promise<Cart>
  get(token: string): Promise<Cart | null>
  addItem(token: string, item: Omit<CartItem, 'qty'> & { qty?: number }): Promise<Cart>
  updateItemQuantity(token: string, variantId: string, qty: number): Promise<Cart>
  removeItem(token: string, variantId: string): Promise<Cart>
  clear(token: string): Promise<Cart>
  merge(guestToken: string, customerToken: string): Promise<Cart>
  attachCustomer(token: string, customerId: string): Promise<Cart>
}

export interface CreateCartServiceDeps {
  documentStore: DocumentStoreAdapter
  publisher: EventPublisher
  logger: Logger
  currency: string
  ttlSeconds?: number
}

function calcSubtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.priceMinor * item.qty, 0)
}

function makeCart(token: string, customerId: string | null, currency: string, ttlSeconds: number): Cart {
  const now = new Date()
  const expires = new Date(now.getTime() + ttlSeconds * 1000)
  return {
    token,
    customerId,
    items: [],
    subtotalMinor: 0,
    currency,
    expiresAt: expires.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

export function createCartService(deps: CreateCartServiceDeps): CartService {
  const { documentStore, publisher, currency } = deps
  const ttlSeconds = deps.ttlSeconds ?? TTL_SECONDS_DEFAULT

  async function save(cart: Cart): Promise<void> {
    await documentStore.put<Cart>(COLLECTION, cart.token, cart, { ttl: ttlSeconds })
  }

  async function emitUpdated(cart: Cart): Promise<void> {
    await publisher.publish(EVT_CART_UPDATED, {
      cartId: cart.token,
      itemCount: cart.items.reduce((n, i) => n + i.qty, 0),
      totalMinor: cart.subtotalMinor,
    })
  }

  async function requireCart(token: string): Promise<Cart> {
    const cart = await documentStore.get<Cart>(COLLECTION, token)
    if (!cart) throw new NotFoundError('cart', token)
    return cart
  }

  return {
    async getOrCreate(token, customerId = null) {
      const t = token ?? uuidv7()
      const existing = await documentStore.get<Cart>(COLLECTION, t)
      if (existing) return existing
      const cart = makeCart(t, customerId, currency, ttlSeconds)
      await save(cart)
      await publisher.publish(EVT_CART_CREATED, { cartId: cart.token, token: cart.token })
      return cart
    },

    async get(token) {
      return documentStore.get<Cart>(COLLECTION, token)
    },

    async addItem(token, item) {
      const cart = await requireCart(token)
      const qty = item.qty ?? 1
      if (qty <= 0) throw new ValidationError(`qty must be positive, got ${qty}`)
      const existing = cart.items.find((i) => i.variantId === item.variantId)
      if (existing) {
        existing.qty += qty
      } else {
        cart.items.push({
          variantId: item.variantId,
          productId: item.productId,
          productName: item.productName,
          variantName: item.variantName,
          priceMinor: item.priceMinor,
          imageUrl: item.imageUrl,
          qty,
        })
      }
      cart.subtotalMinor = calcSubtotal(cart.items)
      cart.updatedAt = new Date().toISOString()
      await save(cart)
      await publisher.publish(EVT_CART_ITEM_ADDED, {
        cartId: cart.token,
        variantId: item.variantId,
        qty,
      })
      await emitUpdated(cart)
      return cart
    },

    async updateItemQuantity(token, variantId, qty) {
      if (qty < 0) throw new ValidationError(`qty must be non-negative, got ${qty}`)
      const cart = await requireCart(token)
      const item = cart.items.find((i) => i.variantId === variantId)
      if (!item) throw new NotFoundError('cart_item', variantId)
      if (qty === 0) {
        cart.items = cart.items.filter((i) => i.variantId !== variantId)
        await publisher.publish(EVT_CART_ITEM_REMOVED, {
          cartId: cart.token,
          variantId,
        })
      } else {
        item.qty = qty
      }
      cart.subtotalMinor = calcSubtotal(cart.items)
      cart.updatedAt = new Date().toISOString()
      await save(cart)
      await emitUpdated(cart)
      return cart
    },

    async removeItem(token, variantId) {
      const cart = await requireCart(token)
      const found = cart.items.some((i) => i.variantId === variantId)
      cart.items = cart.items.filter((i) => i.variantId !== variantId)
      cart.subtotalMinor = calcSubtotal(cart.items)
      cart.updatedAt = new Date().toISOString()
      await save(cart)
      if (found) {
        await publisher.publish(EVT_CART_ITEM_REMOVED, {
          cartId: cart.token,
          variantId,
        })
      }
      await emitUpdated(cart)
      return cart
    },

    async clear(token) {
      const cart = await requireCart(token)
      cart.items = []
      cart.subtotalMinor = 0
      cart.updatedAt = new Date().toISOString()
      await save(cart)
      await emitUpdated(cart)
      return cart
    },

    async attachCustomer(token, customerId) {
      const cart = await requireCart(token)
      cart.customerId = customerId
      cart.updatedAt = new Date().toISOString()
      await save(cart)
      await emitUpdated(cart)
      return cart
    },

    async merge(guestToken, customerToken) {
      const guest = await documentStore.get<Cart>(COLLECTION, guestToken)
      if (!guest) return requireCart(customerToken)
      const customerCart = await documentStore.get<Cart>(COLLECTION, customerToken)
      if (!customerCart) {
        guest.token = customerToken
        await save(guest)
        await documentStore.delete(COLLECTION, guestToken)
        await emitUpdated(guest)
        return guest
      }
      for (const g of guest.items) {
        const existing = customerCart.items.find((i) => i.variantId === g.variantId)
        if (existing) {
          existing.qty = Math.max(existing.qty, g.qty)
        } else {
          customerCart.items.push(g)
        }
      }
      customerCart.subtotalMinor = calcSubtotal(customerCart.items)
      customerCart.updatedAt = new Date().toISOString()
      await save(customerCart)
      await documentStore.delete(COLLECTION, guestToken)
      await emitUpdated(customerCart)
      return customerCart
    },
  }
}
