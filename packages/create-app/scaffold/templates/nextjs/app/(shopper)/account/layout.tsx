'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@nymbalhq/react'
import { AuthGuard, PUBLIC_AUTH_PATHS } from '@/components/client/AuthGuard'
import styles from '@/styles/pages/account.module.css'

const NAV_LINKS = [
  { href: '/account', label: 'Dashboard' },
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/addresses', label: 'Addresses' },
  { href: '/account/profile', label: 'Profile' },
]

export default function AccountLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { logout } = useAuth()

  if (PUBLIC_AUTH_PATHS.includes(pathname)) {
    return <>{children}</>
  }

  async function signOut() {
    await logout()
    router.push('/account/login')
  }

  return (
    <AuthGuard>
      <div className={`container ${styles.page}`}>
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <nav className={styles.sidebarNav} aria-label="Account navigation">
              {NAV_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className={styles.sidebarLink}>
                  {link.label}
                </Link>
              ))}
              <hr className={styles.sidebarDivider} />
              <button
                type="button"
                onClick={signOut}
                className={`${styles.sidebarLink} ${styles.logoutLink}`}
              >
                Sign Out
              </button>
            </nav>
          </aside>
          <div className={styles.content}>{children}</div>
        </div>
      </div>
    </AuthGuard>
  )
}
