import { headers } from 'next/headers'
import { SiteHeader } from '@/components/client/elements'
import { fetchCart } from '@/lib/api'
import { HEADER } from '@/lib/chrome'
import { canSearch, siteHeader } from '@/lib/header'
import { renderNymbal } from '@/lib/render'

function HeaderElement({ header }: { header: ReturnType<typeof siteHeader> }) {
  const serverHtml = renderNymbal('nymbal-site-header', header.attributes, header.children).__html
  return (
    <SiteHeader
      links={HEADER.links}
      logo={HEADER.logo}
      accountHref={HEADER.accountHref}
      serverHtml={serverHtml}
    />
  )
}

/**
 * The header of a page. `shopper` reads the request's cart cookie, so the count is in the HTML with JavaScript off and
 * the page renders per request; without it the page may be cached for every shopper, and the mini-cart fills its count
 * in the browser.
 */
export async function Header({ shopper = false }: { shopper?: boolean }) {
  const cookie = shopper ? (await headers()).get('cookie') : null
  const [search, cart] = await Promise.all([canSearch(), shopper ? fetchCart(cookie) : null])
  return <HeaderElement header={siteHeader(search, cart?.itemCount)} />
}

/**
 * The header with no search bar and no count, for the root 404: Next renders that 404 into every page under the root
 * layout and at build, so it can neither read the request (a cached page would fail) nor call the API (a build with
 * the API down would fail).
 */
export function PlainHeader() {
  return <HeaderElement header={siteHeader(false)} />
}
