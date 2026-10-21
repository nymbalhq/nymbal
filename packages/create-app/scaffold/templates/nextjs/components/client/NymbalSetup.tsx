'use client'

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { NymbalProvider } from '@nymbalhq/react'
import '@/elements'
import { registerClient } from '@nymbalhq/web-components'
import { NymbalCartDrawer } from '@nymbalhq/web-components/elements/nymbal-cart-drawer'
import { NymbalMiniCart } from '@nymbalhq/web-components/elements/nymbal-mini-cart'
import { NymbalSearchBar } from '@nymbalhq/web-components/elements/nymbal-search-bar'
import { getNymbalClient, restoreSession } from '@/lib/client'

export function NymbalSetup({ children }: { children: ReactNode }) {
  const client = getNymbalClient()
  const initialized = useRef(false)

  // A layout effect runs before every passive effect of the commit, so the client is registered before any wrapper
  // defines its element (each wrapper defines its own, so a route loads only the elements it renders).
  useLayoutEffect(() => {
    if (!initialized.current) {
      registerClient(client)
      NymbalSearchBar.define()
      NymbalMiniCart.define()
      NymbalCartDrawer.define()
      client.cart.load()
      void restoreSession()
      initialized.current = true
    }
  }, [client])

  return <NymbalProvider client={client}>{children}</NymbalProvider>
}
