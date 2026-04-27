import Link from 'next/link'
import styles from './Footer.module.css'

const SHOP_LINKS = [
  { href: '/products', label: 'All Products' },
  { href: '/products?category=new', label: 'New Arrivals' },
  { href: '/products?category=sale', label: 'Sale' },
]

const ACCOUNT_LINKS = [
  { href: '/account', label: 'My Account' },
  { href: '/account/orders', label: 'Order History' },
  { href: '/account/login', label: 'Sign In' },
  { href: '/account/register', label: 'Create Account' },
]

const ABOUT_LINKS = [
  { href: '/about', label: 'About Us' },
  { href: '/contact', label: 'Contact' },
  { href: '/shipping', label: 'Shipping & Returns' },
  { href: '/privacy', label: 'Privacy Policy' },
]

export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className={styles.footer} data-testid="site-footer">
      <div className={`container ${styles.inner}`}>
        <div className={styles.columns}>
          <div className={styles.column}>
            <h2 className={styles.heading}>Shop</h2>
            <ul className={styles.list}>
              {SHOP_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={styles.link}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.column}>
            <h2 className={styles.heading}>Account</h2>
            <ul className={styles.list}>
              {ACCOUNT_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={styles.link}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.column}>
            <h2 className={styles.heading}>About</h2>
            <ul className={styles.list}>
              {ABOUT_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={styles.link}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className={styles.bottom}>
          <p className={styles.copyright}>
            &copy; {year} Nymbal. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}
