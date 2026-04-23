import Link from 'next/link'
import { SearchBarWrapper } from '@/components/client/SearchBarWrapper'
import { MiniCartWrapper } from '@/components/client/MiniCartWrapper'
import styles from './Header.module.css'

const NAV_LINKS = [
  { href: '/products', label: 'Shop' },
  { href: '/products?category=new', label: 'New Arrivals' },
  { href: '/products?category=sale', label: 'Sale' },
]

export function Header() {
  return (
    <header className={styles.header} data-testid="site-header">
      <div className={`container ${styles.inner}`}>
        <Link href="/" className={styles.logo}>
          Nymbal
        </Link>

        <nav className={styles.nav} aria-label="Main navigation">
          <ul className={styles.navList}>
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={styles.navLink}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.actions}>
          <div className={styles.search}>
            <SearchBarWrapper />
          </div>
          <Link href="/account" className={styles.iconLink} aria-label="Account">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </Link>
          <MiniCartWrapper />
        </div>

        <input
          type="checkbox"
          id="mobile-menu-toggle"
          className={styles.menuCheckbox}
          aria-hidden="true"
        />
        <label
          htmlFor="mobile-menu-toggle"
          className={styles.menuButton}
          aria-label="Toggle menu"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </label>

        <nav className={styles.mobileNav} aria-label="Mobile navigation">
          <ul className={styles.mobileNavList}>
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={styles.mobileNavLink}>
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/account" className={styles.mobileNavLink}>
                Account
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  )
}
