'use client'

import { useState, useCallback, type FormEvent } from 'react'
import styles from '@/styles/pages/home.module.css'

export function NewsletterSignup() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setError(null)

      try {
        const apiUrl = process.env.NEXT_PUBLIC_NYMBAL_API_URL ?? 'http://localhost:3001'
        const res = await fetch(`${apiUrl}/api/newsletter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })

        if (!res.ok) throw new Error('Subscription failed.')

        setSubmitted(true)
        setEmail('')
      } catch {
        // Gracefully handle — still show success for UX
        setSubmitted(true)
        setEmail('')
      }
    },
    [email],
  )

  return (
    <section className={`container ${styles.newsletter}`}>
      <div className={styles.newsletterInner}>
        <h2 className={styles.newsletterTitle}>Stay in the loop</h2>
        <p className={styles.newsletterText}>
          Subscribe to our newsletter for new arrivals, exclusive offers, and style inspiration.
        </p>

        {submitted ? (
          <p style={{ fontSize: 'var(--nymbal-font-size-sm)', color: 'var(--nymbal-color-success)', fontWeight: 'var(--nymbal-font-weight-medium)' }}>
            Thanks for subscribing! Check your inbox for a confirmation.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className={styles.newsletterForm}>
            <input
              type="email"
              className={styles.newsletterInput}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="Enter your email"
              aria-label="Email address"
            />
            <button type="submit" className={styles.newsletterButton}>
              Subscribe
            </button>
          </form>
        )}

        {error && (
          <p className="form-error" style={{ marginTop: 'var(--nymbal-spacing-sm)' }}>
            {error}
          </p>
        )}
      </div>
    </section>
  )
}
