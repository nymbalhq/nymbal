'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import styles from '@/styles/pages/error.module.css'
import { confirmAlertAction, unsubscribeAlertAction } from './actions'
import { LinkInvalid } from './LinkInvalid'

const PAGES = {
  confirm: {
    action: confirmAlertAction,
    title: 'Confirm your email alert',
    message: 'Press the button to start the alert this email asked for.',
    label: 'Confirm alert',
    invalid: 'It may be from an older email, or the alert has been stopped.',
  },
  unsubscribe: {
    action: unsubscribeAlertAction,
    title: 'Stop this email alert',
    message: "Press the button and we won't email you about this product again.",
    label: 'Unsubscribe',
    invalid: 'Check that the whole link from the email was opened.',
  },
}

/**
 * An alert link's page: opening it changes nothing, so a mail scanner that fetches it, or runs its scripts, leaves
 * the alert as it was. The button posts the token to a server action, with JavaScript on or off.
 */
export function AlertLinkForm({ kind, token }: { kind: keyof typeof PAGES; token: string }) {
  const page = PAGES[kind]
  const [state, formAction, pending] = useActionState(page.action, null)

  if (state === null) {
    return (
      <form action={formAction} className={styles.page} data-testid={`alert-${kind}-form`}>
        <div className={styles.wrapper}>
          <h1 className={styles.title}>{page.title}</h1>
          <p className={styles.message}>{page.message}</p>
          <input type="hidden" name="token" value={token} />
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.homeLink}
              data-testid={`alert-${kind}-submit`}
              disabled={pending}
            >
              {page.label}
            </button>
          </div>
        </div>
      </form>
    )
  }
  if (state.result === 'invalid') return <LinkInvalid message={page.invalid} />
  if (state.result === 'unsubscribed') {
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
  const { kind: alertKind, product } = state.confirmation
  return (
    <div className={styles.page} data-testid="alert-confirmed" data-kind={alertKind}>
      <div className={styles.wrapper}>
        <h1 className={styles.title}>Your alert is on</h1>
        {alertKind === 'price_drop' ? (
          <p className={styles.message}>
            We&apos;ll email you when the price of{' '}
            <Link href={`/product/${product.slug}`}>{product.name}</Link> drops.
          </p>
        ) : (
          <p className={styles.message}>
            We&apos;ll email you once when <Link href={`/product/${product.slug}`}>{product.name}</Link>{' '}
            is back in stock.
          </p>
        )}
      </div>
    </div>
  )
}
