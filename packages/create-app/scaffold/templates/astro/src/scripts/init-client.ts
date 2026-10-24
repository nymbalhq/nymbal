import '../lib/client.js'
import { NymbalCartDrawer } from '@nymbalhq/web-components/elements/nymbal-cart-drawer'
import { NymbalMiniCart } from '@nymbalhq/web-components/elements/nymbal-mini-cart'
import { NymbalSearchBar } from '@nymbalhq/web-components/elements/nymbal-search-bar'
import { NymbalSiteFooter } from '@nymbalhq/web-components/elements/nymbal-site-footer'
import { NymbalSiteHeader } from '@nymbalhq/web-components/elements/nymbal-site-header'
import { NymbalToast } from '@nymbalhq/web-components/elements/nymbal-toast'

// The layout's elements; each page script defines the ones its page renders.
NymbalSiteHeader.define()
NymbalSiteFooter.define()
NymbalSearchBar.define()
NymbalMiniCart.define()
NymbalCartDrawer.define()
NymbalToast.define()

// Navigate to checkout when the cart drawer checkout button is clicked
document.addEventListener('nymbal:cart:checkout-clicked', () => {
  window.location.href = '/checkout'
})

// Choosing a header search suggestion (click or Enter) opens that product
document.addEventListener('nymbal:search:selected', ((
  e: CustomEvent<{ product?: { slug?: string } }>,
) => {
  const slug = e.detail?.product?.slug
  if (slug) {
    window.location.href = `/product/${encodeURIComponent(slug)}`
  }
}) as EventListener)
