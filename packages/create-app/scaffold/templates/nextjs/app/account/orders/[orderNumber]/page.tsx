'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useNymbalClient } from '@nymbalhq/react'
import type { Order } from '@nymbalhq/types'
import { formatPrice, formatDate } from '@/lib/format'
import styles from '@/styles/pages/account.module.css'
import confirmStyles from '@/styles/pages/confirmation.module.css'

export default function OrderDetailPage() {
  const params = useParams<{ orderNumber: string }>()
  const orderNumber = decodeURIComponent(params.orderNumber ?? '')
  const client = useNymbalClient()
  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orderNumber) return
    let active = true
    client.customer.orders
      .get(orderNumber)
      .then((found) => {
        if (active) setOrder(found)
      })
      .catch(() => {
        if (active) setOrder(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, orderNumber])

  if (loading) {
    return (
      <div>
        <h2 className={styles.pageTitle}>Order Details</h2>
        <div className="loading-center">
          <div className="spinner spinner-lg" role="status">
            <span className="visually-hidden">Loading order...</span>
          </div>
        </div>
      </div>
    )
  }

  if (!order) {
    return (
      <div>
        <h2 className={styles.pageTitle}>Order Not Found</h2>
        <p className="text-muted">This order could not be found.</p>
        <Link
          href="/account/orders"
          className="btn btn-outline"
          style={{ marginTop: 'var(--nymbal-spacing-md)', display: 'inline-flex' }}
        >
          Back to Orders
        </Link>
      </div>
    )
  }

  return (
    <div data-testid="order-detail">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 'var(--nymbal-spacing-sm)',
          marginBottom: 'var(--nymbal-spacing-lg)',
        }}
      >
        <h2 className={styles.pageTitle} style={{ marginBottom: 0 }}>
          Order #{order.orderNumber}
        </h2>
        <span
          className={`${styles.orderStatus} ${styles.statusPending}`}
          style={{ textTransform: 'capitalize' }}
        >
          {order.status}
        </span>
      </div>

      {order.createdAt && (
        <p className="text-sm text-muted mb-md">Placed on {formatDate(order.createdAt)}</p>
      )}

      <div className={styles.formCard} style={{ marginBottom: 'var(--nymbal-spacing-lg)' }}>
        <h3 className={styles.formCardTitle}>Items</h3>
        <div className={confirmStyles.lineItems}>
          {order.lineItems.map((item) => (
            <div key={item.variantId} className={confirmStyles.lineItem}>
              {item.imageUrl && (
                <div className={confirmStyles.lineItemImage}>
                  <img src={item.imageUrl} alt={item.productName} />
                </div>
              )}
              <div className={confirmStyles.lineItemInfo}>
                <p className={confirmStyles.lineItemName}>{item.productName}</p>
                {item.variantName && (
                  <p className={confirmStyles.lineItemVariant}>{item.variantName}</p>
                )}
                <p className={confirmStyles.lineItemQty}>Qty: {item.qty}</p>
              </div>
              <span className={confirmStyles.lineItemPrice}>
                {formatPrice(item.lineTotalMinor, order.currency)}
              </span>
            </div>
          ))}
        </div>

        <div className={confirmStyles.totals}>
          <div className={confirmStyles.totalRow}>
            <span className={confirmStyles.totalLabel}>Subtotal</span>
            <span>{formatPrice(order.subtotalMinor, order.currency)}</span>
          </div>
          <div className={confirmStyles.totalRow}>
            <span className={confirmStyles.totalLabel}>Shipping</span>
            <span>
              {order.shippingTotalMinor === 0
                ? 'Free'
                : formatPrice(order.shippingTotalMinor, order.currency)}
            </span>
          </div>
          <div className={confirmStyles.totalRow}>
            <span className={confirmStyles.totalLabel}>Tax</span>
            <span>{formatPrice(order.taxTotalMinor, order.currency)}</span>
          </div>
          <div className={`${confirmStyles.totalRow} ${confirmStyles.totalGrand}`}>
            <span>Total</span>
            <span>{formatPrice(order.totalMinor, order.currency)}</span>
          </div>
        </div>
      </div>

      <div className={styles.formCard}>
        <h3 className={styles.formCardTitle}>Delivery Details</h3>
        <div
          className={confirmStyles.addressGrid}
          style={{ marginTop: 'var(--nymbal-spacing-md)' }}
        >
          {order.shippingAddress && (
            <div className={confirmStyles.addressCard}>
              <h4 className={confirmStyles.addressTitle}>Shipping Address</h4>
              <p className={confirmStyles.addressText}>
                {order.shippingAddress.firstName} {order.shippingAddress.lastName}
                <br />
                {order.shippingAddress.addressLine1}
                {order.shippingAddress.addressLine2 && <>, {order.shippingAddress.addressLine2}</>}
                <br />
                {order.shippingAddress.city}, {order.shippingAddress.region}{' '}
                {order.shippingAddress.postalCode}
                <br />
                {order.shippingAddress.country}
              </p>
            </div>
          )}
          {order.billingAddress && (
            <div className={confirmStyles.addressCard}>
              <h4 className={confirmStyles.addressTitle}>Billing Address</h4>
              <p className={confirmStyles.addressText}>
                {order.billingAddress.firstName} {order.billingAddress.lastName}
                <br />
                {order.billingAddress.addressLine1}
                {order.billingAddress.addressLine2 && <>, {order.billingAddress.addressLine2}</>}
                <br />
                {order.billingAddress.city}, {order.billingAddress.region}{' '}
                {order.billingAddress.postalCode}
                <br />
                {order.billingAddress.country}
              </p>
            </div>
          )}
        </div>
      </div>

      <Link
        href="/account/orders"
        className="btn btn-outline"
        style={{ marginTop: 'var(--nymbal-spacing-lg)', display: 'inline-flex' }}
      >
        Back to Orders
      </Link>
    </div>
  )
}
