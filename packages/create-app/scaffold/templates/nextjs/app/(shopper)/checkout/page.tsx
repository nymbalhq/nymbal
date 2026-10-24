import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { fetchCapabilities, fetchCart } from '@/lib/api'
import { renderNymbal } from '@/lib/render'
import { CheckoutView } from './CheckoutView'

export const metadata: Metadata = {
  title: 'Checkout',
}

const escapeAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

export default async function CheckoutRoute() {
  const [capabilities, cart] = await Promise.all([
    fetchCapabilities(),
    headers().then((h) => fetchCart(h.get('cookie'))),
  ])
  if (capabilities === null) {
    throw new Error(
      'The store did not answer GET /api/capabilities, so checkout cannot tell how to take a payment.',
    )
  }
  // The payments adapter's client half, as the checkout's light-DOM child in its payment slot; a driver the project
  // registers in lib/client.ts renders it.
  const payment = `<nymbal-payment-element slot="payment" client="${escapeAttribute(
    JSON.stringify(capabilities.payments.client),
  )}" data-testid="payment-element"></nymbal-payment-element>`
  const serverHtml = renderNymbal(
    'nymbal-checkout',
    cart === null ? {} : { cart: JSON.stringify(cart) },
    payment,
  ).__html
  return (
    <div className="container section">
      <CheckoutView cart={cart} serverHtml={serverHtml} />
    </div>
  )
}
