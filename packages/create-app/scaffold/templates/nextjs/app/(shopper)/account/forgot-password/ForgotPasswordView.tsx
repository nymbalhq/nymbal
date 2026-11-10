'use client'

import Link from 'next/link'
import { ForgotPasswordForm } from '@nymbalhq/react'
import styles from '@/styles/pages/account.module.css'

/** `serverHtml` is the form as the server rendered it (page.tsx). */
export function ForgotPasswordView({ serverHtml }: { serverHtml: string }) {
  return (
    <div className={styles.authPage}>
      <div className={styles.authCard}>
        <h1 className={styles.authTitle}>Forgot Password</h1>
        <p className={styles.authSubtitle}>
          Enter your email and we will send you a link to set a new one.
        </p>
        <ForgotPasswordForm serverHtml={serverHtml} />
        <p className={styles.authFooter}>
          Remembered it? <Link href="/account/login">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
