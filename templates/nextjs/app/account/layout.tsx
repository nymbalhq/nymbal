import type { ReactNode } from 'react'
import Link from 'next/link'
import { AuthGuard } from '@/components/client/AuthGuard'
import styles from '@/styles/pages/account.module.css'

const NAV_LINKS = [
  { href: '/account', label: 'Dashboard' },
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/addresses', label: 'Addresses' },
  { href: '/account/profile', label: 'Profile' },
]

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <div className={`container ${styles.page}`}>
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <nav className={styles.sidebarNav} aria-label="Account navigation">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={styles.sidebarLink}
                >
                  {link.label}
                </Link>
              ))}
              <hr className={styles.sidebarDivider} />
              <Link
                href="/account/login"
                className={`${styles.sidebarLink} ${styles.logoutLink}`}
              >
                Sign Out
              </Link>
            </nav>
          </aside>
          <div className={styles.content}>{children}</div>
        </div>
      </div>
    </AuthGuard>
  )
}
