'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Checkout, PaymentElement } from '@nymbalhq/react'
import type { PaymentClient } from '@nymbalhq/types'

/** The element places the order; the page only goes to it. */
export function CheckoutView({ paymentClient }: { paymentClient: PaymentClient | null }) {
  const router = useRouter()
  const onPlaced = useCallback(
    (event: CustomEvent<{ orderNumber: string }>) => {
      router.push(`/order/${encodeURIComponent(event.detail.orderNumber)}`)
    },
    [router],
  )

  return (
    <Checkout onPlaced={onPlaced}>
      <PaymentElement slot="payment" client={paymentClient} data-testid="payment-element" />
    </Checkout>
  )
}
