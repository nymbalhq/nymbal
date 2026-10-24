import { fetchCapabilities } from '@/lib/api'
import { HEADER } from '@/lib/chrome'
import { renderElement } from '@/lib/render'

/**
 * The store's nymbal-site-header as the server renders it: its attributes, and the search bar (when the store searches)
 * and the mini-cart as its light-DOM children, each with the slot it fills. React cannot give children beside the
 * header's server HTML, so they go in that HTML. The mini-cart has a count only on a shopper's own page; a shared,
 * cached header has none.
 */
export function siteHeader(
  search: boolean,
  cartCount?: number,
): { attributes: Record<string, string>; children: string } {
  const miniCart: Record<string, string> = { slot: 'cart' }
  if (cartCount !== undefined) miniCart['count'] = String(cartCount)
  const children = [
    search
      ? renderElement('nymbal-search-bar', {
          attributes: { slot: 'search', placeholder: 'Search products...', 'debounce-ms': '300' },
        })
      : '',
    renderElement('nymbal-mini-cart', { attributes: miniCart }),
  ].join('')
  return {
    attributes: {
      links: JSON.stringify(HEADER.links),
      logo: HEADER.logo,
      'account-href': HEADER.accountHref,
    },
    children,
  }
}

/** Whether the store searches, which puts the search bar in the header. */
export async function canSearch(): Promise<boolean> {
  const capabilities = await fetchCapabilities()
  return capabilities?.search.capabilities.includes('search') ?? false
}
