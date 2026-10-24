import type { ReactNode } from 'react'
import { Header } from '@/components/server/Header'

// The shopper's own pages render per request: the header reads the cart cookie, so its count is in the HTML.
export default function ShopperLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Header shopper />
      <main id="main">{children}</main>
    </>
  )
}
