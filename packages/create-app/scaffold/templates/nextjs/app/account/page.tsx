'use client'

import Link from 'next/link'
import { useAuth } from '@nymbal/react'
import styles from '@/styles/pages/account.module.css'

export default function AccountDashboard() {
  const { customer } = useAuth()

  const greeting = customer?.firstName ? `Welcome back, ${customer.firstName}` : 'Welcome back'

  return (
    <div>
      <h2 className={styles.pageTitle}>{greeting}</h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))', gap: 'var(--nymbal-spacing-md)' }}>
        <Link href="/account/orders" className={styles.formCard} style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3 className={styles.formCardTitle}>Orders</h3>
          <p className="text-sm text-muted">View your order history and track shipments.</p>
        </Link>
        <Link href="/account/addresses" className={styles.formCard} style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3 className={styles.formCardTitle}>Addresses</h3>
          <p className="text-sm text-muted">Manage your shipping and billing addresses.</p>
        </Link>
        <Link href="/account/profile" className={styles.formCard} style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3 className={styles.formCardTitle}>Profile</h3>
          <p className="text-sm text-muted">Update your personal information.</p>
        </Link>
        <Link href="/products" className={styles.formCard} style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3 className={styles.formCardTitle}>Shop</h3>
          <p className="text-sm text-muted">Browse our latest products and collections.</p>
        </Link>
      </div>
    </div>
  )
}
