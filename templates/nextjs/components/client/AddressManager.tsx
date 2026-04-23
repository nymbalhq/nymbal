'use client'

import { useAuth } from '@nymbal/react'
import styles from '@/styles/pages/account.module.css'

export function AddressManager() {
  const { customer } = useAuth()

  const addresses = customer?.addresses ?? []

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--nymbal-spacing-lg)' }}>
        <h2 className={styles.pageTitle} style={{ marginBottom: 0 }}>
          Addresses
        </h2>
      </div>

      {addresses.length > 0 ? (
        <div className={styles.orderList}>
          {addresses.map((addr) => (
            <div key={addr.id} className={styles.formCard} style={{ marginBottom: 'var(--nymbal-spacing-md)' }}>
              <p style={{ fontSize: 'var(--nymbal-font-size-sm)', lineHeight: 1.6 }}>
                {addr.addressLine1}
                {addr.addressLine2 && <>, {addr.addressLine2}</>}
                <br />
                {addr.city}, {addr.region} {addr.postalCode}
                <br />
                {addr.country}
              </p>
              <div style={{ display: 'flex', gap: 'var(--nymbal-spacing-sm)', marginTop: 'var(--nymbal-spacing-sm)' }}>
                {addr.isDefaultShipping && (
                  <span className="badge">Default Shipping</span>
                )}
                {addr.isDefaultBilling && (
                  <span className="badge">Default Billing</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.emptyOrders}>
          <h3 className={styles.emptyOrdersTitle}>No saved addresses</h3>
          <p className={styles.emptyOrdersText}>
            Addresses will be saved when you complete a checkout.
          </p>
        </div>
      )}
    </div>
  )
}
