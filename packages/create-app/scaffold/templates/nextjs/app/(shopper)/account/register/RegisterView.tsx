'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { RegisterForm } from '@nymbalhq/react'
import styles from '@/styles/pages/account.module.css'

/** `serverHtml` is the form as the server rendered it (page.tsx). */
export function RegisterView({ serverHtml }: { serverHtml: string }) {
  const router = useRouter()
  const onSignedIn = useCallback(() => router.push('/account'), [router])

  return (
    <div className={styles.authPage}>
      <div className={styles.authCard}>
        <h1 className={styles.authTitle}>Create Account</h1>
        <p className={styles.authSubtitle}>Join us and start shopping.</p>
        <RegisterForm onSignedIn={onSignedIn} serverHtml={serverHtml} />
        <p className={styles.authFooter}>
          Already have an account? <Link href="/account/login">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
