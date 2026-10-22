'use client'

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { NymbalProvider } from '@nymbalhq/react'
import '@/elements'
import { registerClient } from '@nymbalhq/web-components'
import { NymbalCartDrawer } from '@nymbalhq/web-components/elements/nymbal-cart-drawer'
import { NymbalMiniCart } from '@nymbalhq/web-components/elements/nymbal-mini-cart'
import { NymbalSearchBar } from '@nymbalhq/web-components/elements/nymbal-search-bar'
import { NymbalSiteFooter } from '@nymbalhq/web-components/elements/nymbal-site-footer'
import { NymbalSiteHeader } from '@nymbalhq/web-components/elements/nymbal-site-header'
import { getNymbalClient, restoreSession } from '@/lib/client'

export function NymbalSetup({ children }: { children: ReactNode }) {
  const client = getNymbalClient()
  const router = useRouter()
  const initialized = useRef(false)

  // A layout effect runs before every passive effect of the commit, so the client is registered before any wrapper
  // defines its element (each wrapper defines its own, so a route loads only the elements it renders). The cart starts
  // loading first, so an element the server rendered from the cart keeps showing it until the load settles.
  useLayoutEffect(() => {
    if (!initialized.current) {
      registerClient(client)
      void client.cart.load()
      NymbalSiteHeader.define()
      NymbalSiteFooter.define()
      NymbalSearchBar.define()
      NymbalMiniCart.define()
      NymbalCartDrawer.define()
      void restoreSession()
      initialized.current = true
    }
  }, [client])

  // The elements' links are plain anchors in shadow roots, which the router does not see: each asks with
  // `nymbal:navigate`, and the router takes it. The header's search bar and mini-cart are in its server HTML, not
  // React children, so their events are taken here too.
  useEffect(() => {
    const navigate = (event: Event): void => {
      const href = (event as CustomEvent<{ href?: string }>).detail?.href
      if (!href || new URL(href, window.location.href).origin !== window.location.origin) return
      event.preventDefault()
      router.push(href)
    }
    const searchSelected = (event: Event): void => {
      const slug = (event as CustomEvent<{ product?: { slug?: string } }>).detail?.product?.slug
      if (slug) router.push(`/product/${encodeURIComponent(slug)}`)
    }
    // Before the drawer's own listener toggles it, as the wrapper's listener on the mini-cart ran.
    const miniCartClicked = (): void => {
      window.dispatchEvent(new CustomEvent('nymbal:cart:open'))
    }
    document.addEventListener('nymbal:navigate', navigate)
    document.addEventListener('nymbal:search:selected', searchSelected)
    document.addEventListener('nymbal:mini-cart:clicked', miniCartClicked, true)
    return () => {
      document.removeEventListener('nymbal:navigate', navigate)
      document.removeEventListener('nymbal:search:selected', searchSelected)
      document.removeEventListener('nymbal:mini-cart:clicked', miniCartClicked, true)
    }
  }, [router])

  return <NymbalProvider client={client}>{children}</NymbalProvider>
}
