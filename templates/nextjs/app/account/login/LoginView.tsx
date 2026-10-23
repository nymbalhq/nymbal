'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LoginForm } from '@nymbalhq/react'
import styles from '@/styles/pages/account.module.css'

/** `serverHtml` is the form as the server rendered it, `redirect` where to go once signed in (page.tsx). */
export function LoginView({ serverHtml, redirect }: { serverHtml: string; redirect?: string }) {
  const router = useRouter()
  const onSignedIn = useCallback(() => {
    router.push(redirect ?? '/account')
  }, [router, redirect])

  return (
    <div className={styles.authPage}>
      <div className={styles.authCard}>
        <h1 className={styles.authTitle}>Sign In</h1>
        <p className={styles.authSubtitle}>Welcome back. Enter your credentials to continue.</p>
        <LoginForm onSignedIn={onSignedIn} serverHtml={serverHtml} />
        <p className={styles.authFooter}>
          Don&apos;t have an account? <Link href="/account/register">Create one</Link>
        </p>
      </div>
    </div>
  )
}
