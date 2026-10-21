'use client'

import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { LoginForm } from '@nymbalhq/react'
import styles from '@/styles/pages/account.module.css'

export function LoginView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const onSignedIn = useCallback(() => {
    router.push(searchParams.get('redirect') ?? '/account')
  }, [router, searchParams])

  return (
    <div className={styles.authPage}>
      <div className={styles.authCard}>
        <h1 className={styles.authTitle}>Sign In</h1>
        <p className={styles.authSubtitle}>Welcome back. Enter your credentials to continue.</p>
        <LoginForm onSignedIn={onSignedIn} />
        <p className={styles.authFooter}>
          Don&apos;t have an account? <Link href="/account/register">Create one</Link>
        </p>
      </div>
    </div>
  )
}
