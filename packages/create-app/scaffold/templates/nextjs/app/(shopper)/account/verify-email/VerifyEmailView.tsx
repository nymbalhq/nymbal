'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { VerifyEmail } from '@nymbalhq/react'
import styles from '@/styles/pages/account.module.css'

/** `serverHtml` is the element as the server rendered it (page.tsx); it reads the link's token from the fragment. */
export function VerifyEmailView({ serverHtml }: { serverHtml: string }) {
  // A full load, as the Astro page makes: the account starts from the session the confirmation's cookie holds.
  const onSignedIn = useCallback(() => window.location.assign('/account'), [])

  return (
    <div className={styles.authPage}>
      <div className={styles.authCard}>
        <h1 className={styles.authTitle}>Confirm Your Email</h1>
        <p className={styles.authSubtitle}>Follow the link we emailed you, or ask for a new one.</p>
        <VerifyEmail onSignedIn={onSignedIn} serverHtml={serverHtml} />
        <p className={styles.authFooter}>
          <Link href="/account/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  )
}
