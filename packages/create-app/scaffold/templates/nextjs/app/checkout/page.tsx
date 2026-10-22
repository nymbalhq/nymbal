import type { Metadata } from 'next'
import { fetchCapabilities } from '@/lib/api'
import { CheckoutView } from './CheckoutView'

export const metadata: Metadata = {
  title: 'Checkout',
}

export default async function CheckoutRoute() {
  const capabilities = await fetchCapabilities()
  if (capabilities === null) {
    throw new Error(
      'The store did not answer GET /api/capabilities, so checkout cannot tell how to take a payment.',
    )
  }
  return (
    <div className="container section">
      <CheckoutView paymentClient={capabilities.payments.client} />
    </div>
  )
}
