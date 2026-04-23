import type { Metadata } from 'next'
import { CartPage } from '@/components/client/CartPage'

export const metadata: Metadata = {
  title: 'Shopping Cart',
}

export default function CartRoute() {
  return <CartPage />
}
