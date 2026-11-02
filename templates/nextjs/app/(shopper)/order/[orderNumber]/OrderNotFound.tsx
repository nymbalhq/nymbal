import Link from 'next/link'
import styles from '@/styles/pages/error.module.css'
import { OrderLinkForm, OwnOrderLinkForm, type LinkFormBinding } from './OrderLinkForm'
import { OwnerRedirect } from './OwnerRedirect'

/**
 * The order page's not-found state: what the site's 404 says, and a way to ask for a fresh order link. `link` is the
 * expired page's action state, which its link form shares; the bare not-found page's form has its own.
 */
export function OrderNotFound({ link }: { link?: LinkFormBinding }) {
  return (
    <div className={styles.page}>
      <OwnerRedirect />
      <div className={styles.wrapper}>
        <p className={styles.statusCode}>404</p>
        <h1 className={styles.title}>Order not found</h1>
        <p className={styles.message}>
          This link does not open an order. Give its order number and the email you gave at
          checkout, and we&apos;ll email you a fresh link if they match.
        </p>
        {link ? <OrderLinkForm binding={link} /> : <OwnOrderLinkForm />}
        <div className={styles.actions}>
          <Link href="/products" className={styles.retryButton}>
            Browse Products
          </Link>
        </div>
      </div>
    </div>
  )
}
