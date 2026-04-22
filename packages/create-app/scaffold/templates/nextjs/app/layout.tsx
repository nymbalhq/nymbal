import type { ReactNode } from 'react'

export const metadata = {
  title: 'Nymbal — Next.js Storefront',
  description: 'Minimal starter — Prompt 4 builds out the full UI.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        {children}
      </body>
    </html>
  )
}
