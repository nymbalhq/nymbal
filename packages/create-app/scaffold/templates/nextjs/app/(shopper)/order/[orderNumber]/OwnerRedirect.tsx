'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { NymbalApiError } from '@nymbalhq/sdk'
import { getNymbalClient, restoreSession } from '@/lib/client'

/**
 * Where a signed-in shopper who opened their own order here without a working key belongs: the order in their
 * account. The session is restored first, which refreshes a lapsed token: the API reads a lapsed bearer as a guest's.
 * Only the owner's read answering gives a path, so anyone else's order stays this page's not-found state and the page
 * says nothing about whether it exists. Null with no session, so a guest's visit sends nothing.
 */
async function ownersAccountPath(orderNumber: string): Promise<string | null> {
  await restoreSession()
  const client = getNymbalClient()
  if (!client.auth.getState().isAuthenticated) return null
  try {
    await client.customer.orders.get(orderNumber)
  } catch (err) {
    if (err instanceof NymbalApiError && err.status === 404) return null
    throw err
  }
  return `/account/orders/${encodeURIComponent(orderNumber)}`
}

/** Sends the order's signed-in owner on to it in their account; replacing the entry keeps Back from returning here. */
export function OwnerRedirect() {
  const params = useParams<{ orderNumber?: string }>()
  const orderNumber = decodeURIComponent(params.orderNumber ?? '')
  const router = useRouter()

  useEffect(() => {
    if (!orderNumber) return
    let active = true
    ownersAccountPath(orderNumber).then(
      (path) => {
        if (active && path !== null) router.replace(path)
      },
      (err: unknown) => console.error('The signed-in order check failed', err),
    )
    return () => {
      active = false
    }
  }, [orderNumber, router])

  return null
}
