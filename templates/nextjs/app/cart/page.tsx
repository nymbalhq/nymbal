import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { fetchCart } from '@/lib/api'
import { renderNymbal } from '@/lib/render'
import CartPage from './CartView'

export const metadata: Metadata = {
  title: 'Shopping Cart',
}

export default async function CartRoute() {
  const cart = await fetchCart((await headers()).get('cookie'))
  const serverHtml = renderNymbal(
    'nymbal-cart-page',
    cart === null ? {} : { cart: JSON.stringify(cart) },
  ).__html
  return (
    <div className="container section" data-testid="cart-page">
      <CartPage cart={cart ?? undefined} serverHtml={serverHtml} />
    </div>
  )
}
