import type { Metadata } from 'next'
import Link from 'next/link'
import { unsubscribeAlert } from '@/lib/api'
import styles from '@/styles/pages/error.module.css'
import { LinkInvalid } from '../LinkInvalid'

export const metadata: Metadata = { title: 'Back-in-stock alert' }

interface UnsubscribePageProps {
  searchParams: Promise<{ token?: string | string[] }>
}

// The unsubscribe link every alert email carries: the token is posted from this server, which holds no CSRF cookie.
export default async function UnsubscribeAlertPage({ searchParams }: UnsubscribePageProps) {
  const { token } = await searchParams
  const value = typeof token === 'string' ? token : ''
  const stopped = value === '' ? false : await unsubscribeAlert(value)

  if (!stopped)
    return <LinkInvalid message="Check that the whole link from the email was opened." />
  return (
    <div className={styles.page} data-testid="alert-unsubscribed">
      <div className={styles.wrapper}>
        <h1 className={styles.title}>Your alert is off</h1>
        <p className={styles.message}>We won&apos;t email you about this product again.</p>
        <div className={styles.actions}>
          <Link href="/products" className={styles.homeLink}>
            Browse Products
          </Link>
        </div>
      </div>
    </div>
  )
}
