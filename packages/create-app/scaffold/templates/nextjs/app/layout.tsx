import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import './globals.css'
import { NymbalSetup } from '@/components/client/NymbalSetup'
import { SiteFooter } from '@/components/client/elements'
import { Header } from '@/components/server/Header'
import { SkipNav } from '@/components/server/SkipNav'
import { CartDrawerToggle } from '@/components/client/CartDrawerToggle'
import { FOOTER_COLUMNS } from '@/lib/chrome'
import { renderNymbal } from '@/lib/render'

export const metadata: Metadata = {
  title: { default: 'Nymbal Store', template: '%s | Nymbal' },
  description: 'Shop the Nymbal store',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const footer = renderNymbal('nymbal-site-footer', { columns: JSON.stringify(FOOTER_COLUMNS) })
  return (
    <html lang="en">
      <body>
        <NymbalSetup>
          <SkipNav />
          <Header />
          <main id="main">{children}</main>
          <SiteFooter columns={FOOTER_COLUMNS} serverHtml={footer.__html} />
          <CartDrawerToggle />
        </NymbalSetup>
      </body>
    </html>
  )
}
