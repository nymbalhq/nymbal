import Link from 'next/link'
import styles from '@/styles/pages/error.module.css'

export default function NotFound() {
  return (
    <div className={styles.page}>
      <div className={styles.wrapper}>
        <div className={`${styles.icon} ${styles.notFoundIcon}`}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <p className={styles.statusCode}>404</p>
        <h1 className={styles.title}>Page Not Found</h1>
        <p className={styles.message}>
          The page you are looking for does not exist or may have been moved.
        </p>
        <div className={styles.actions}>
          <Link href="/" className={styles.homeLink}>
            Go Home
          </Link>
          <Link href="/products" className={styles.retryButton}>
            Browse Products
          </Link>
        </div>
      </div>
    </div>
  )
}
