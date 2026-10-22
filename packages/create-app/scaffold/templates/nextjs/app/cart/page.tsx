import type { Metadata } from 'next'
import CartPage from './CartView'

export const metadata: Metadata = {
  title: 'Shopping Cart',
}

export default function CartRoute() {
  return (
    <div className="container section" data-testid="cart-page">
      <CartPage />
    </div>
  )
}
