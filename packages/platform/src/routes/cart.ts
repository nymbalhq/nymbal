import { type HttpAdapter, type ResponseCookie, type ResponseEnvelope } from '@nymbalhq/types'
import { isSellable, type CartService } from '../services/cart-service.js'
import type { AfterSignIn } from './auth.js'
import type { ProductRepository } from '../repositories/product.js'
import type { VariantRepository } from '../repositories/variant.js'
import { ok, fail, renderError } from './envelope.js'

const CART_COOKIE = 'nymbal.cart'

interface AddItemBody {
  variantId?: string
  qty?: number
}

interface UpdateBody {
  qty?: number
}

function cookie(token: string): ResponseCookie[] {
  return [
    {
      name: CART_COOKIE,
      value: token,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 30,
    },
  ]
}

/** Ends the browser's cart, as logout does and a sign-in does for a cart that is not the customer's to keep. */
export function expiredCartCookie(): ResponseCookie {
  return { name: CART_COOKIE, value: '', path: '/', maxAge: 0, httpOnly: true }
}

/** The sign-in hook that folds the browser's guest cart into the customer's and points the cookie at the result. */
export function mergeCartOnSignIn(cart: CartService): AfterSignIn {
  return async (ctx, customerId) => {
    const guestToken = ctx.cookies[CART_COOKIE]
    const result = await cart.signIn(guestToken, customerId)
    if (result !== null) return cookie(result.token)
    return guestToken === undefined ? [] : [expiredCartCookie()]
  }
}

export interface RegisterCartRoutesDeps {
  cart: CartService
  productRepo: ProductRepository
  variantRepo: VariantRepository
}

export function registerCartRoutes(adapter: HttpAdapter, deps: RegisterCartRoutesDeps): void {
  const { cart, productRepo, variantRepo } = deps

  adapter.registerRoute('GET', '/api/cart', async (ctx) => {
    try {
      const token = ctx.cookies[CART_COOKIE]
      const existing = token ? await cart.get(token) : null
      if (existing) return ok(existing) as ResponseEnvelope
      const fresh = await cart.getOrCreate()
      const env = ok(fresh)
      env.cookies = cookie(fresh.token)
      return env as ResponseEnvelope
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('POST', '/api/cart/items', async (ctx) => {
    try {
      const body = ctx.body as AddItemBody | undefined
      if (!body?.variantId) return fail('cart.invalid', 'variantId required', 400)
      const qty = body.qty ?? 1
      const { variantId } = body
      const variant = await variantRepo.store.read((tx) => variantRepo.findById(tx, variantId))
      const product =
        variant &&
        (await productRepo.store.read((tx) => productRepo.findById(tx, variant.productId)))
      // What is not for sale answers as an unknown id does, so a draft's existence is not disclosed.
      if (!variant || !product || !isSellable(variant, product)) {
        return fail('cart.variant_missing', 'variant not found', 404)
      }
      if (variant.stock < qty) {
        return fail('cart.out_of_stock', 'insufficient stock', 409, {
          variantId: variant.id,
          available: variant.stock,
        })
      }
      const token = ctx.cookies[CART_COOKIE] ?? (await cart.getOrCreate()).token
      const updated = await cart.addItem(token, {
        variantId: variant.id,
        productId: product.id,
        productSlug: product.slug,
        productName: product.name,
        variantName: variant.name,
        priceMinor: variant.priceMinor,
        qty,
        imageUrl: (product.media[0] as { url?: string } | undefined)?.url ?? '',
      })
      const env = ok(updated)
      env.cookies = cookie(token)
      return env as ResponseEnvelope
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('PATCH', '/api/cart/items/:variantId', async (ctx) => {
    try {
      const token = ctx.cookies[CART_COOKIE]
      if (!token) return fail('cart.missing', 'no active cart', 404)
      const variantId = ctx.params.variantId
      if (!variantId) return fail('cart.variant_required', 'variantId param required', 400)
      const qty = (ctx.body as UpdateBody | undefined)?.qty ?? 0
      const updated = await cart.updateItemQuantity(token, variantId, qty)
      return ok(updated)
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('DELETE', '/api/cart/items/:variantId', async (ctx) => {
    try {
      const token = ctx.cookies[CART_COOKIE]
      if (!token) return fail('cart.missing', 'no active cart', 404)
      const variantId = ctx.params.variantId
      if (!variantId) return fail('cart.variant_required', 'variantId param required', 400)
      const updated = await cart.removeItem(token, variantId)
      return ok(updated)
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('DELETE', '/api/cart', async (ctx) => {
    try {
      const token = ctx.cookies[CART_COOKIE]
      if (!token) return fail('cart.missing', 'no active cart', 404)
      const cleared = await cart.clear(token)
      return ok(cleared)
    } catch (err) {
      return renderError(err)
    }
  })
}
