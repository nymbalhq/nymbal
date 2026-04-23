'use client'

import { useState, useCallback, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@nymbal/react'
import styles from '@/styles/pages/account.module.css'

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { login } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setError(null)
      setLoading(true)

      try {
        await login(email, password)
        const redirect = searchParams.get('redirect') ?? '/account'
        router.push(redirect)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid email or password.')
        setLoading(false)
      }
    },
    [email, password, login, router, searchParams],
  )

  return (
    <div className={styles.authPage}>
      <div className={styles.authCard} data-testid="login-form">
        <h1 className={styles.authTitle}>Sign In</h1>
        <p className={styles.authSubtitle}>Welcome back. Enter your credentials to continue.</p>

        {error && <div className={styles.alertError + ' ' + styles.alert}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.authForm}>
          <div className="form-group">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="login-email"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              data-testid="login-password"
              placeholder="Enter your password"
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            className={styles.authSubmit}
            disabled={loading}
            data-testid="login-submit"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className={styles.authFooter}>
          Don&apos;t have an account?{' '}
          <Link href="/account/register">Create one</Link>
        </p>
      </div>
    </div>
  )
}
