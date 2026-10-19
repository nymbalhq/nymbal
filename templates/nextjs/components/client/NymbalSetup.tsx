'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { NymbalProvider } from '@nymbalhq/react'
import { registerClient, registerComponents } from '@nymbalhq/web-components'
import '@nymbalhq/web-components/tokens.css'
import { getNymbalClient, restoreSession } from '@/lib/client'

export function NymbalSetup({ children }: { children: ReactNode }) {
  const client = getNymbalClient()
  const initialized = useRef(false)

  useEffect(() => {
    if (!initialized.current) {
      registerClient(client)
      registerComponents()
      client.cart.load()
      void restoreSession()
      initialized.current = true
    }
  }, [client])

  return <NymbalProvider client={client}>{children}</NymbalProvider>
}
