import Link from 'next/link'
import styles from '@/styles/pages/error.module.css'

/** What an alert link that the store refuses shows: an older email's confirmation, or a link cut short. */
export function LinkInvalid({ message }: { message: string }) {
  return (
    <div className={styles.page} data-testid="alert-link-invalid">
      <div className={styles.wrapper}>
        <h1 className={styles.title}>This link is not valid</h1>
        <p className={styles.message}>{message}</p>
        <div className={styles.actions}>
          <Link href="/products" className={styles.homeLink}>
            Browse Products
          </Link>
        </div>
      </div>
    </div>
  )
}
