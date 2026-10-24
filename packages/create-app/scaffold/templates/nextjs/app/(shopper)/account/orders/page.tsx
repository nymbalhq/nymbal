'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useNymbalClient } from '@nymbalhq/react'
import type { Order } from '@nymbalhq/types'
import { formatPrice, formatDate } from '@/lib/format'
import styles from '@/styles/pages/account.module.css'

function getStatusClass(status: string): string {
  const map: Record<string, string> = {
    pending: styles.statusPending,
    confirmed: styles.statusConfirmed,
    processing: styles.statusProcessing,
    shipped: styles.statusShipped,
    delivered: styles.statusDelivered,
    cancelled: styles.statusCancelled,
    refunded: styles.statusRefunded,
  }
  return map[status.toLowerCase()] ?? styles.statusPending
}

export default function OrdersPage() {
  const client = useNymbalClient()
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    client.customer.orders
      .list()
      .then((page) => {
        if (active) setOrders(page.items)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client])

  if (loading) {
    return (
      <div>
        <h2 className={styles.pageTitle}>Order History</h2>
        <div className="loading-center">
          <div className="spinner spinner-lg" role="status">
            <span className="visually-hidden">Loading orders...</span>
          </div>
        </div>
      </div>
    )
  }

  if (failed) {
    return (
      <div>
        <h2 className={styles.pageTitle}>Order History</h2>
        <p className="text-muted">Unable to load orders. Please try again later.</p>
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div>
        <h2 className={styles.pageTitle}>Order History</h2>
        <div className={styles.emptyOrders}>
          <h3 className={styles.emptyOrdersTitle}>No orders yet</h3>
          <p className={styles.emptyOrdersText}>When you place an order, it will appear here.</p>
          <Link
            href="/products"
            className="btn btn-primary"
            style={{ marginTop: 'var(--nymbal-spacing-md)', display: 'inline-flex' }}
          >
            Start Shopping
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 className={styles.pageTitle}>Order History</h2>
      <div className={styles.orderList} data-testid="orders-list">
        {orders.map((order) => (
          <div key={order.id} className={styles.orderCard}>
            <div className={styles.orderHeader}>
              <Link
                href={`/account/orders/${encodeURIComponent(order.orderNumber)}`}
                className={styles.orderNumber}
                data-testid={`order-${order.orderNumber}`}
              >
                #{order.orderNumber}
              </Link>
              <span className={`${styles.orderStatus} ${getStatusClass(order.status)}`}>
                {order.status}
              </span>
            </div>
            <div className={styles.orderMeta}>
              {order.createdAt && (
                <span>
                  <span className={styles.orderMetaLabel}>Date: </span>
                  {formatDate(order.createdAt)}
                </span>
              )}
              <span>
                <span className={styles.orderMetaLabel}>Total: </span>
                {formatPrice(order.totalMinor, order.currency)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
