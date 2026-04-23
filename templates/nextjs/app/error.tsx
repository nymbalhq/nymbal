'use client'

import Link from 'next/link'
import styles from '@/styles/pages/error.module.css'

interface ErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function ErrorPage({ error: _error, reset }: ErrorProps) {
  return (
    <div className={styles.page}>
      <div className={styles.wrapper}>
        <div className={styles.icon}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 className={styles.title}>Something went wrong</h1>
        <p className={styles.message}>
          An unexpected error occurred. Please try again or return to the home page.
        </p>
        <div className={styles.actions}>
          <Link href="/" className={styles.homeLink}>
            Go Home
          </Link>
          <button
            type="button"
            className={styles.retryButton}
            onClick={reset}
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  )
}
