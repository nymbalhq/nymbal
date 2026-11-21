'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { ResetPasswordForm } from '@nymbalhq/react'
import styles from '@/styles/pages/account.module.css'

/** `serverHtml` is the form as the server rendered it (page.tsx); the form reads the link's token from the fragment. */
export function ResetPasswordView({ serverHtml }: { serverHtml: string }) {
  // A full load, as the Astro page makes: the account starts from the session the reset's cookie holds.
  const onSignedIn = useCallback(() => window.location.assign('/account'), [])

  return (
    <div className={styles.authPage}>
      <div className={styles.authCard}>
        <h1 className={styles.authTitle}>Set a New Password</h1>
        <p className={styles.authSubtitle}>Choose a password of at least 8 characters.</p>
        <ResetPasswordForm onSignedIn={onSignedIn} serverHtml={serverHtml} />
        <p className={styles.authFooter}>
          <Link href="/account/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  )
}
