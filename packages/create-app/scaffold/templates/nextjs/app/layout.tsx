import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import './globals.css'
import { NymbalSetup } from '@/components/client/NymbalSetup'
import { Header } from '@/components/server/Header'
import { Footer } from '@/components/server/Footer'
import { SkipNav } from '@/components/server/SkipNav'
import { CartDrawerToggle } from '@/components/client/CartDrawerToggle'

export const metadata: Metadata = {
  title: { default: 'Nymbal Store', template: '%s | Nymbal' },
  description: 'Shop the Nymbal store',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NymbalSetup>
          <SkipNav />
          <Header />
          <main id="main">{children}</main>
          <Footer />
          <CartDrawerToggle />
        </NymbalSetup>
      </body>
    </html>
  )
}
