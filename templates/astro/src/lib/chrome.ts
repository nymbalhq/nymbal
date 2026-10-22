import { renderElement } from '@nymbalhq/web-components/ssr'
import './server-elements'

// The store's header and footer, rendered by nymbal-site-header and nymbal-site-footer: edit the links here.

export const HEADER = {
  logo: 'Nymbal',
  'account-href': '/account',
  links: JSON.stringify([
    { label: 'Apparel', href: '/category/apparel' },
    { label: 'Home', href: '/category/home' },
    { label: 'Electronics', href: '/category/electronics' },
    { label: 'Books', href: '/category/books' },
    { label: 'All Products', href: '/products' },
  ]),
}

export const FOOTER = {
  columns: JSON.stringify([
    {
      heading: 'Shop',
      links: [
        { label: 'All Products', href: '/products' },
        { label: 'Apparel', href: '/category/apparel' },
        { label: 'Home', href: '/category/home' },
        { label: 'Electronics', href: '/category/electronics' },
        { label: 'Books', href: '/category/books' },
      ],
    },
    {
      heading: 'Account',
      links: [
        { label: 'Login', href: '/account/login' },
        { label: 'Register', href: '/account/register' },
        { label: 'Orders', href: '/account/orders' },
      ],
    },
    {
      heading: 'About',
      text: 'Nymbal is a modern headless commerce platform built for developers. Fast, flexible, and fully customisable.',
    },
  ]),
}

/**
 * The header's light-DOM children, each rendered by the server with the slot it fills: the search bar (when the store
 * searches) and the mini-cart with the shopper's count (none in a shared, cached header). HTML, not markup: Astro
 * would take `slot` on a component's child as a slot of NymbalElement's own.
 */
export function headerSlots(canSearch: boolean, cartCount?: number): string {
  const search = canSearch
    ? renderElement('nymbal-search-bar', {
        attributes: { slot: 'search', placeholder: 'Search products...', 'debounce-ms': '300' },
      })
    : ''
  const attributes: Record<string, string> = { slot: 'cart' }
  if (cartCount !== undefined) attributes['count'] = String(cartCount)
  return search + renderElement('nymbal-mini-cart', { attributes })
}
