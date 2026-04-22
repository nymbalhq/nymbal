import { type Address, type HttpAdapter } from '@nymbal/types'
import type { CheckoutService } from '../services/checkout-service.js'
import { ok, fail, renderError } from './envelope.js'

const CART_COOKIE = 'nymbal.cart'

interface BeginBody {
  email?: string
  billingAddress?: Address
  shippingAddress?: Address
  notes?: string
}

export function registerCheckoutRoutes(adapter: HttpAdapter, checkout: CheckoutService): void {
  adapter.registerRoute('POST', '/api/checkout', async (ctx) => {
    try {
      const body = ctx.body as BeginBody | undefined
      const cartToken = ctx.cookies[CART_COOKIE]
      if (!cartToken) return fail('checkout.no_cart', 'No active cart', 400)
      if (!body?.email || !body.billingAddress || !body.shippingAddress) {
        return fail(
          'checkout.invalid',
          'email, billingAddress, shippingAddress are required',
          400,
        )
      }
      const result = await checkout.beginCheckout({
        cartToken,
        ...(ctx.auth?.userId !== undefined && { customerId: ctx.auth.userId }),
        email: body.email,
        billingAddress: body.billingAddress,
        shippingAddress: body.shippingAddress,
        ...(body.notes !== undefined && { notes: body.notes }),
      })
      return ok({
        orderId: result.orderId,
        paymentIntent: result.paymentIntent,
        currency: result.currency,
        totalMinor: result.totalMinor,
      })
    } catch (err) {
      return renderError(err)
    }
  })
}
