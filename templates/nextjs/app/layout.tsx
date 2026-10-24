import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import './globals.css'
import { NymbalSetup } from '@/components/client/NymbalSetup'
import { SiteFooter } from '@/components/client/elements'
import { SkipNav } from '@/components/server/SkipNav'
import { CartDrawerToggle } from '@/components/client/CartDrawerToggle'
import { FOOTER_COLUMNS } from '@/lib/chrome'
import { renderNymbal } from '@/lib/render'

export const metadata: Metadata = {
  title: { default: 'Nymbal Store', template: '%s | Nymbal' },
  description: 'Shop the Nymbal store',
}

// The root layout makes no API call: Next renders the 404 under it at build, when the API may be down. Each route
// group's layout brings the header the group's pages share, (catalog)'s cached for every shopper, (shopper)'s per request.
export default function RootLayout({ children }: { children: ReactNode }) {
  const footer = renderNymbal('nymbal-site-footer', { columns: JSON.stringify(FOOTER_COLUMNS) })
  return (
    <html lang="en">
      <body>
        <NymbalSetup>
          <SkipNav />
          {children}
          <SiteFooter columns={FOOTER_COLUMNS} serverHtml={footer.__html} />
          <CartDrawerToggle />
        </NymbalSetup>
      </body>
    </html>
  )
}
