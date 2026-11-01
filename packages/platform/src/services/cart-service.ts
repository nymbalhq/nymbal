import { v7 as uuidv7 } from 'uuid'
import {
  CART_LINE_MAX_QTY,
  CartLimitError,
  EVT_CART_CREATED,
  EVT_CART_ITEM_ADDED,
  EVT_CART_ITEM_REMOVED,
  EVT_CART_UPDATED,
  NotFoundError,
  ValidationError,
  type Cart,
  type CartItem,
  type Logger,
  type Product,
  type Variant,
} from '@nymbalhq/types'
import type { CommandStore, ReadTx, Tx } from '../db/command-store.js'
import type { CartRepository } from '../repositories/cart.js'
import { createOrderRepository, type OrderRepository } from '../repositories/order.js'
import { createProductRepository, type ProductRepository } from '../repositories/product.js'
import { createVariantRepository, type VariantRepository } from '../repositories/variant.js'
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
  /** The customer's cart once the guest cart at `guestToken` is folded into it; null when there is neither. */
  signIn(guestToken: string | undefined, customerId: string): Promise<Cart | null>
}

/** A variant can go on a cart while it and its product are both active. */
export function isSellable(
  variant: Pick<Variant, 'status'>,
  product: Pick<Product, 'status'>,
): boolean {
  return variant.status === 'active' && product.status === 'active'
}

/** Which variants can be on a cart: the variant and its product both exist and are sellable. */
export interface CartCatalogue {
  sellable(tx: ReadTx, variantIds: readonly string[]): Promise<ReadonlySet<string>>
}

export function createCartCatalogue(repos: {
  variant: VariantRepository
  product: ProductRepository
}): CartCatalogue {
  return {
    async sellable(tx, variantIds) {
      const sellable = new Set<string>()
      for (const id of new Set(variantIds)) {
        const variant = await repos.variant.findById(tx, id)
        const product = variant && (await repos.product.findById(tx, variant.productId))
        if (variant && product && isSellable(variant, product)) sellable.add(id)
      }
      return sellable
    },
  }
}

export interface CreateCartServiceDeps {
  store: CommandStore
  carts: CartRepository
  publisher: EventPublisher
  logger: Logger
  currency: string
  /** Which variants a cart may keep at a sign-in; the store's variants and products by default. */
  catalogue?: CartCatalogue
  /** Finds a guest cart's checkout in progress, which keeps that cart at a sign-in; the store's orders by default. */
  pendingOrders?: Pick<OrderRepository, 'findPendingByCartToken'>
  ttlSeconds?: number
  now?: () => Date
}

function calcSubtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.priceMinor * item.qty, 0)
}

/** Every variant of either side once, at the summed quantity up to the ceiling; `kept`'s fields win for a shared one. */
function combine(kept: CartItem[], folded: CartItem[], sellable: ReadonlySet<string>): CartItem[] {
  const foldedQty = new Map(folded.map((i) => [i.variantId, i.qty]))
  const keptIds = new Set(kept.map((i) => i.variantId))
  return [
    ...kept.map((i) => ({
      ...i,
      qty: Math.min(CART_LINE_MAX_QTY, i.qty + (foldedQty.get(i.variantId) ?? 0)),
    })),
    ...folded.filter((i) => !keptIds.has(i.variantId)),
  ].filter((i) => sellable.has(i.variantId))
}

export function createCartService(deps: CreateCartServiceDeps): CartService {
  const { store, carts, publisher, currency } = deps
  const catalogue =
    deps.catalogue ??
    createCartCatalogue({
      variant: createVariantRepository(store),
      product: createProductRepository(store),
    })
  const pendingOrders = deps.pendingOrders ?? createOrderRepository(store)
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
   * Locks the carts in token order, so two transactions taking the same pair cannot each hold one and wait; answers
   * each token's cart as locked, null for none.
   */
  async function lockAll(
    tx: Tx,
    tokens: readonly string[],
  ): Promise<(token: string) => Cart | null> {
    const locked = new Map<string, Cart | null>()
    for (const token of [...new Set(tokens)].sort()) locked.set(token, await carts.lock(tx, token))
    return (token) => locked.get(token) ?? null
  }

  async function sellableOf(tx: Tx, ...sides: CartItem[][]): Promise<ReadonlySet<string>> {
    return catalogue.sellable(
      tx,
      sides.flatMap((items) => items.map((i) => i.variantId)),
    )
  }

  /**
   * Folds `guest` into `customer`, both locked, and removes the one folded. A guest cart with a checkout in progress
   * is the one kept instead, so the pending order, keyed by its token, keeps its cart.
   */
  async function fold(
    tx: Tx,
    guest: Cart,
    customer: Cart,
    customerId: string | null,
    at: Date,
  ): Promise<Cart> {
    const guestPending = (await pendingOrders.findPendingByCartToken(tx, guest.token)) !== null
    const [kept, folded] = guestPending ? [guest, customer] : [customer, guest]
    const items = combine(kept.items, folded.items, await sellableOf(tx, kept.items, folded.items))
    const merged = { ...written(kept, items, at), customerId }
    await carts.remove(tx, folded.token)
    await carts.put(tx, merged)
    await emitUpdated(merged)
    return merged
  }

  /** The one cart a customer signing in keeps: its unsellable lines dropped, attached to the customer. */
  async function claim(tx: Tx, cart: Cart, customerId: string, at: Date): Promise<Cart> {
    const sellable = await sellableOf(tx, cart.items)
    const items = cart.items.filter((i) => sellable.has(i.variantId))
    if (items.length === cart.items.length && cart.customerId === customerId) return cart
    const claimed = { ...written(cart, items, at), customerId }
    await carts.put(tx, claimed)
    await emitUpdated(claimed)
    return claimed
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
        const line = cart.items.find((i) => i.variantId === item.variantId)
        const onCart = line?.qty ?? 0
        if (onCart + qty > CART_LINE_MAX_QTY) {
          throw new CartLimitError(item.variantId, CART_LINE_MAX_QTY, onCart)
        }
        const items = line
          ? cart.items.map((i) => (i.variantId === item.variantId ? { ...i, qty: i.qty + qty } : i))
          : [
              ...cart.items,
              {
                variantId: item.variantId,
                productId: item.productId,
                ...(item.productSlug !== undefined && { productSlug: item.productSlug }),
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
        const line = cart.items.find((i) => i.variantId === variantId)
        if (!line) throw new NotFoundError('cart_item', variantId)
        if (qty > CART_LINE_MAX_QTY)
          throw new CartLimitError(variantId, CART_LINE_MAX_QTY, line.qty)
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
        const locked = await lockAll(tx, [guestToken, customerToken])
        const guest = locked(guestToken)
        const customerCart = locked(customerToken)
        if (!live(guest, at) || guestToken === customerToken) {
          if (!live(customerCart, at)) throw new NotFoundError('cart', customerToken)
          return customerCart
        }
        // With no live cart at the customer's token, the guest's lines go to an empty one there, replacing an expired
        // row if there is one.
        const customer = live(customerCart, at)
          ? customerCart
          : { ...guest, token: customerToken, items: [] }
        return fold(tx, guest, customer, customer.customerId, at)
      })
    },

    async signIn(guestToken, customerId) {
      return store.transaction(async (tx) => {
        const at = now()
        const own = await carts.findLiveByCustomer(tx, customerId, at)
        const ownToken = own !== null && own.token !== guestToken ? own.token : undefined
        // The lookup above holds nothing: what counts is each cart as it is once locked, after any sign-in or command
        // that held it first.
        const locked = await lockAll(
          tx,
          [guestToken, ownToken].filter((t): t is string => t !== undefined),
        )
        const g = guestToken === undefined ? null : locked(guestToken)
        const c = ownToken === undefined ? null : locked(ownToken)
        // Another customer's cart is never theirs to take, whatever cookie the request carried.
        const guest = live(g, at) && (g.customerId ?? customerId) === customerId ? g : null
        const customer = live(c, at) && c.customerId === customerId ? c : null
        if (guest && customer) return fold(tx, guest, customer, customerId, at)
        const only = guest ?? customer
        return only ? claim(tx, only, customerId, at) : null
      })
    },
  }
}
