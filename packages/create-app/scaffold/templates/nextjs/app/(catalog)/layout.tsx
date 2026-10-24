import type { ReactNode } from 'react'
import { Header } from '@/components/server/Header'

// The catalog's pages are the same for every shopper, so Next may cache them: the header reads no request, and the
// mini-cart fills its count in the browser.
export default function CatalogLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Header />
      <main id="main">{children}</main>
    </>
  )
}
