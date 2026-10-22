import { headers } from 'next/headers'
import { SiteHeader } from '@/components/client/elements'
import { fetchCapabilities, fetchCart } from '@/lib/api'
import { HEADER } from '@/lib/chrome'
import { renderElement, renderNymbal } from '@/lib/render'

/**
 * The store's header with the page's search bar and mini-cart as its light-DOM children, each rendered by the server
 * with the slot it fills; React cannot give children beside the header's server HTML, so they go in that HTML.
 */
export async function Header() {
  const [capabilities, cart] = await Promise.all([
    fetchCapabilities(),
    headers().then((h) => fetchCart(h.get('cookie'))),
  ])
  const canSearch = capabilities?.search.capabilities.includes('search') ?? false
  const miniCart: Record<string, string> = { slot: 'cart' }
  if (cart !== null) miniCart['count'] = String(cart.itemCount)
  const children = [
    canSearch
      ? renderElement('nymbal-search-bar', {
          attributes: { slot: 'search', placeholder: 'Search products...', 'debounce-ms': '300' },
        })
      : '',
    renderElement('nymbal-mini-cart', { attributes: miniCart }),
  ].join('')
  const serverHtml = renderNymbal(
    'nymbal-site-header',
    { links: JSON.stringify(HEADER.links), logo: HEADER.logo, 'account-href': HEADER.accountHref },
    children,
  ).__html
  return (
    <SiteHeader
      links={HEADER.links}
      logo={HEADER.logo}
      accountHref={HEADER.accountHref}
      serverHtml={serverHtml}
    />
  )
}
