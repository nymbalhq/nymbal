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
  type Logger,
} from '@nymbalhq/types'
import type { CommandStore, Tx } from '../db/command-store.js'
import type { CartRepository } from '../repositories/cart.js'
import type { EventPublisher } from '../events/publisher.js'

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
  store: CommandStore
  carts: CartRepository
  publisher: EventPublisher
  logger: Logger
  currency: string
  ttlSeconds?: number
  now?: () => Date
}

function calcSubtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.priceMinor * item.qty, 0)
}

export function createCartService(deps: CreateCartServiceDeps): CartService {
  const { store, carts, publisher, currency } = deps
  const ttlMs = (deps.ttlSeconds ?? TTL_SECONDS_DEFAULT) * 1000
  const now = deps.now ?? (() => new Date())

  /** A cart past its expiry reads as missing, whether or not the sweeper has deleted it yet. */
  function live(cart: Cart | null, at: Date): cart is Cart {
    return cart !== null && Date.parse(cart.expiresAt) > at.getTime()
  }

  /** The cart after a write at `at`: these items, and an expiry that slides to `at + ttl`. */
  function written(cart: Cart, items: CartItem[], at: Date): Cart {
    return {
      ...cart,
      items,
      subtotalMinor: calcSubtotal(items),
      updatedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
    }
  }

  async function requireCart(tx: Tx, token: string, at: Date): Promise<Cart> {
    const cart = await carts.lock(tx, token)
    if (!live(cart, at)) throw new NotFoundError('cart', token)
    return cart
  }

  async function emitUpdated(cart: Cart): Promise<void> {
    await publisher.publish(EVT_CART_UPDATED, {
      cartId: cart.token,
      itemCount: cart.items.reduce((n, i) => n + i.qty, 0),
      totalMinor: cart.subtotalMinor,
    })
  }

  /**
   * One command on one cart, in one transaction: the row is held from the read to the write, so a concurrent command
   * (another replica's included) waits and then sees this one's result, and the events commit with the write.
   */
  function command(token: string, change: (cart: Cart, at: Date) => Promise<Cart>): Promise<Cart> {
    return store.transaction(async (tx) => {
      const at = now()
      const next = await change(await requireCart(tx, token, at), at)
      await carts.put(tx, next)
      await emitUpdated(next)
      return next
    })
  }

  return {
    async getOrCreate(token, customerId = null) {
      return store.transaction(async (tx) => {
        const at = now()
        const { cart, created } = await carts.create(tx, {
          token: token ?? uuidv7(),
          customerId,
          items: [],
          subtotalMinor: 0,
          currency,
          expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        })
        if (created) {
          await publisher.publish(EVT_CART_CREATED, { cartId: cart.token, token: cart.token })
        }
        return cart
      })
    },

    async get(token) {
      const at = now()
      const cart = await store.read((tx) => carts.findByToken(tx, token))
      return live(cart, at) ? cart : null
    },

    async addItem(token, item) {
      return command(token, async (cart, at) => {
        const qty = item.qty ?? 1
        if (qty <= 0) throw new ValidationError(`qty must be positive, got ${qty}`)
        const onCart = cart.items.some((i) => i.variantId === item.variantId)
        const items = onCart
          ? cart.items.map((i) => (i.variantId === item.variantId ? { ...i, qty: i.qty + qty } : i))
          : [
              ...cart.items,
              {
                variantId: item.variantId,
                productId: item.productId,
                productName: item.productName,
                variantName: item.variantName,
                priceMinor: item.priceMinor,
                imageUrl: item.imageUrl,
                qty,
              },
            ]
        await publisher.publish(EVT_CART_ITEM_ADDED, {
          cartId: cart.token,
          variantId: item.variantId,
          qty,
        })
        return written(cart, items, at)
      })
    },

    async updateItemQuantity(token, variantId, qty) {
      if (qty < 0) throw new ValidationError(`qty must be non-negative, got ${qty}`)
      return command(token, async (cart, at) => {
        if (!cart.items.some((i) => i.variantId === variantId)) {
          throw new NotFoundError('cart_item', variantId)
        }
        if (qty === 0) {
          await publisher.publish(EVT_CART_ITEM_REMOVED, { cartId: cart.token, variantId })
          return written(
            cart,
            cart.items.filter((i) => i.variantId !== variantId),
            at,
          )
        }
        return written(
          cart,
          cart.items.map((i) => (i.variantId === variantId ? { ...i, qty } : i)),
          at,
        )
      })
    },

    async removeItem(token, variantId) {
      return command(token, async (cart, at) => {
        const items = cart.items.filter((i) => i.variantId !== variantId)
        if (items.length < cart.items.length) {
          await publisher.publish(EVT_CART_ITEM_REMOVED, { cartId: cart.token, variantId })
        }
        return written(cart, items, at)
      })
    },

    async clear(token) {
      return command(token, async (cart, at) => written(cart, [], at))
    },

    async attachCustomer(token, customerId) {
      return command(token, async (cart, at) => ({ ...written(cart, cart.items, at), customerId }))
    },

    async merge(guestToken, customerToken) {
      return store.transaction(async (tx) => {
        const at = now()
        const guest = await carts.lock(tx, guestToken)
        if (!live(guest, at)) return requireCart(tx, customerToken, at)
        const customerCart = await carts.lock(tx, customerToken)
        let merged: Cart
        if (live(customerCart, at)) {
          const held = customerCart.items
          const items = [
            ...held.map((i) => {
              const g = guest.items.find((x) => x.variantId === i.variantId)
              return g ? { ...i, qty: Math.max(i.qty, g.qty) } : i
            }),
            ...guest.items.filter((g) => !held.some((i) => i.variantId === g.variantId)),
          ]
          merged = written(customerCart, items, at)
        } else {
          // The guest cart takes the customer's token, replacing an expired cart there if there is one.
          merged = written({ ...guest, token: customerToken }, guest.items, at)
        }
        await carts.remove(tx, guestToken)
        await carts.put(tx, merged)
        await emitUpdated(merged)
        return merged
      })
    },
  }
}
