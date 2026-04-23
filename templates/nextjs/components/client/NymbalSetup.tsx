'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { NymbalProvider } from '@nymbal/react'
import { registerClient, registerComponents } from '@nymbal/web-components'
import '@nymbal/web-components/tokens.css'
import { getNymbalClient } from '@/lib/client'

export function NymbalSetup({ children }: { children: ReactNode }) {
  const client = getNymbalClient()
  const initialized = useRef(false)

  useEffect(() => {
    if (!initialized.current) {
      registerClient(client)
      registerComponents()
      client.cart.load()
      initialized.current = true
    }
  }, [client])

  return <NymbalProvider client={client}>{children}</NymbalProvider>
}
