'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useAuth } from '@nymbal/react'
import { formatPrice, formatDate } from '@/lib/format'
import styles from '@/styles/pages/account.module.css'

interface OrderSummary {
  id: string
  orderNumber: string
  status: string
  totalMinor: number
  currency: string
  createdAt?: string
}

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
  const { customer } = useAuth()
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadOrders() {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_NYMBAL_API_URL ?? 'http://localhost:3001'
        const res = await fetch(`${apiUrl}/api/orders`, {
          credentials: 'include',
        })
        if (res.ok) {
          const data = await res.json()
          setOrders(data.items ?? data ?? [])
        }
      } catch {
        // silently fail
      } finally {
        setLoading(false)
      }
    }

    loadOrders()
  }, [customer])

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

  if (orders.length === 0) {
    return (
      <div>
        <h2 className={styles.pageTitle}>Order History</h2>
        <div className={styles.emptyOrders}>
          <h3 className={styles.emptyOrdersTitle}>No orders yet</h3>
          <p className={styles.emptyOrdersText}>
            When you place an order, it will appear here.
          </p>
          <Link href="/products" className="btn btn-primary" style={{ marginTop: 'var(--nymbal-spacing-md)', display: 'inline-flex' }}>
            Start Shopping
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 className={styles.pageTitle}>Order History</h2>
      <div className={styles.orderList}>
        {orders.map((order) => (
          <div key={order.id} className={styles.orderCard}>
            <div className={styles.orderHeader}>
              <Link
                href={`/account/orders/${order.id}`}
                className={styles.orderNumber}
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
