'use client'

import { useState, useCallback, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@nymbal/react'
import styles from '@/styles/pages/account.module.css'

export function RegisterForm() {
  const router = useRouter()
  const { register } = useAuth()

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setError(null)

      if (password !== confirmPassword) {
        setError('Passwords do not match.')
        return
      }

      setLoading(true)

      try {
        await register({ firstName, lastName, email, password })
        router.push('/account')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Registration failed. Please try again.')
        setLoading(false)
      }
    },
    [firstName, lastName, email, password, confirmPassword, register, router],
  )

  return (
    <div className={styles.authPage}>
      <div className={styles.authCard} data-testid="register-form">
        <h1 className={styles.authTitle}>Create Account</h1>
        <p className={styles.authSubtitle}>Join us and start shopping.</p>

        {error && <div className={styles.alertError + ' ' + styles.alert}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.authForm}>
          <div className="form-group">
            <label htmlFor="register-first-name">First Name</label>
            <input
              id="register-first-name"
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
              placeholder="First name"
              autoComplete="given-name"
            />
          </div>
          <div className="form-group">
            <label htmlFor="register-last-name">Last Name</label>
            <input
              id="register-last-name"
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
              placeholder="Last name"
              autoComplete="family-name"
            />
          </div>
          <div className="form-group">
            <label htmlFor="register-email">Email</label>
            <input
              id="register-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="register-email"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <label htmlFor="register-password">Password</label>
            <input
              id="register-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Create a password"
              autoComplete="new-password"
              minLength={8}
            />
          </div>
          <div className="form-group">
            <label htmlFor="register-confirm-password">Confirm Password</label>
            <input
              id="register-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              placeholder="Confirm your password"
              autoComplete="new-password"
            />
          </div>
          <button
            type="submit"
            className={styles.authSubmit}
            disabled={loading}
          >
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        <p className={styles.authFooter}>
          Already have an account?{' '}
          <Link href="/account/login">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
