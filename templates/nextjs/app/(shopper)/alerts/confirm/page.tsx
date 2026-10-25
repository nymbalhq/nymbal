import type { Metadata } from 'next'
import Link from 'next/link'
import { confirmAlert } from '@/lib/api'
import styles from '@/styles/pages/error.module.css'
import { LinkInvalid } from '../LinkInvalid'

export const metadata: Metadata = { title: 'Back-in-stock alert' }

interface ConfirmPageProps {
  searchParams: Promise<{ token?: string | string[] }>
}

// The link in a confirmation email: the token is posted from this server, so the browser needs no CSRF cookie.
export default async function ConfirmAlertPage({ searchParams }: ConfirmPageProps) {
  const { token } = await searchParams
  const value = typeof token === 'string' ? token : ''
  const confirmed = value === '' ? null : await confirmAlert(value)

  if (confirmed === null) {
    return <LinkInvalid message="It may be from an older email, or the alert has been stopped." />
  }
  return (
    <div className={styles.page} data-testid="alert-confirmed">
      <div className={styles.wrapper}>
        <h1 className={styles.title}>Your alert is on</h1>
        <p className={styles.message}>
          We&apos;ll email you once when{' '}
          <Link href={`/product/${confirmed.product.slug}`}>{confirmed.product.name}</Link> is back
          in stock.
        </p>
      </div>
    </div>
  )
}
