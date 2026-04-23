import type { Metadata } from 'next'
import { CheckoutForm } from '@/components/client/CheckoutForm'

export const metadata: Metadata = {
  title: 'Checkout',
}

export default function CheckoutRoute() {
  return <CheckoutForm />
}
