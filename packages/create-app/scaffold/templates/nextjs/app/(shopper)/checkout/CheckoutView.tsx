'use client'

import { useCallback, useEffect } from 'react'
import { Checkout } from '@nymbalhq/react'
import { NymbalPaymentElement } from '@nymbalhq/web-components/elements/nymbal-payment-element'
import type { CartProjection } from '@/lib/api'

/**
 * The element places the order; the page only goes to it. The server rendered the checkout with its payment element
 * as a light-DOM child (`serverHtml`), which is defined here: it stays mounted by its driver in the browser.
 */
export function CheckoutView({
  cart,
  serverHtml,
}: {
  cart: CartProjection | null
  serverHtml: string
}) {
  // A full load, not router.push: the order page's URL carries its key, and only a document of its own takes the
  // page's Referrer-Policy header. A soft navigation leaves it in the checkout's document, whose requests (its
  // script chunks among them) refer the keyed URL on.
  const onPlaced = useCallback((event: CustomEvent<{ orderNumber: string; orderKey?: string }>) => {
    const { orderNumber, orderKey } = event.detail
    window.location.assign(
      `/order/${encodeURIComponent(orderNumber)}${orderKey ? `?key=${encodeURIComponent(orderKey)}` : ''}`,
    )
  }, [])

  useEffect(() => {
    NymbalPaymentElement.define()
  }, [])

  return <Checkout cart={cart ?? undefined} serverHtml={serverHtml} onPlaced={onPlaced} />
}
