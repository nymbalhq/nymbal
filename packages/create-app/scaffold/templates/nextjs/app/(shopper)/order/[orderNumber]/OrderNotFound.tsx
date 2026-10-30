import Link from 'next/link'
import styles from '@/styles/pages/error.module.css'
import { OrderLinkForm } from './OrderLinkForm'

/** The order page's not-found state: what the site's 404 says, and a way to ask for a fresh order link. */
export function OrderNotFound() {
  return (
    <div className={styles.page}>
      <div className={styles.wrapper}>
        <p className={styles.statusCode}>404</p>
        <h1 className={styles.title}>Order not found</h1>
        <p className={styles.message}>
          This link does not open an order. Give its order number and the email you gave at
          checkout, and we&apos;ll email you a fresh link if they match.
        </p>
        <OrderLinkForm />
        <div className={styles.actions}>
          <Link href="/products" className={styles.retryButton}>
            Browse Products
          </Link>
        </div>
      </div>
    </div>
  )
}
