'use client'

import { useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Checkout } from '@nymbalhq/react'
import { NymbalPaymentElement } from '@nymbalhq/web-components/elements/nymbal-payment-element'
import type { CartProjection } from '@/lib/api'

/**
 * The element places the order; the page only goes to it. The server rendered the checkout with its payment element
 * as a light-DOM child (`serverHtml`), which is defined here: it stays mounted by its driver in the browser.
 */
export function CheckoutView({ cart, serverHtml }: { cart: CartProjection | null; serverHtml: string }) {
  const router = useRouter()
  const onPlaced = useCallback(
    (event: CustomEvent<{ orderNumber: string }>) => {
      router.push(`/order/${encodeURIComponent(event.detail.orderNumber)}`)
    },
    [router],
  )

  useEffect(() => {
    NymbalPaymentElement.define()
  }, [])

  return <Checkout cart={cart ?? undefined} serverHtml={serverHtml} onPlaced={onPlaced} />
}
