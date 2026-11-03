import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { cartPageCart, hasCartCookie, type CartProjection } from '@/lib/api'
import { renderElement, renderNymbal } from '@/lib/render'
import CartPage from './CartView'

export const metadata: Metadata = {
  title: 'Shopping Cart',
}

/** With JavaScript off: the empty cart, with the element's loading shell hidden. */
function noScriptEmptyCart(cart: CartProjection): string {
  return (
    '<style>nymbal-cart-page:not([cart]) { display: none; }</style>' +
    renderElement('nymbal-cart-page', { attributes: { cart: JSON.stringify(cart) } })
  )
}

export default async function CartRoute() {
  const cookie = (await headers()).get('cookie')
  const cart = await cartPageCart(cookie)
  // Without the cookie this server cannot tell an empty cart from one the browser holds for an API on another host, so
  // the empty cart is for a browser without JavaScript; with it, the element's own read decides.
  const noCookie = !hasCartCookie(cookie)
  const shown = noCookie ? null : cart
  const serverHtml = renderNymbal(
    'nymbal-cart-page',
    shown === null ? {} : { cart: JSON.stringify(shown) },
  ).__html
  return (
    <div className="container section" data-testid="cart-page">
      <CartPage cart={shown ?? undefined} serverHtml={serverHtml} />
      {noCookie && cart !== null && (
        <noscript dangerouslySetInnerHTML={{ __html: noScriptEmptyCart(cart) }} />
      )}
    </div>
  )
}
