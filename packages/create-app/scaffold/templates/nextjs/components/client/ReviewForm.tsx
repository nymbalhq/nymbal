'use client'

import { useState, useCallback, type FormEvent } from 'react'
import styles from '@/styles/pages/pdp.module.css'

interface ReviewFormProps {
  productId: string
}

export function ReviewForm({ productId }: ReviewFormProps) {
  const [rating, setRating] = useState(5)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setSubmitting(true)
      setError(null)

      try {
        const apiUrl = process.env.NEXT_PUBLIC_NYMBAL_API_URL ?? 'http://localhost:3001'
        const res = await fetch(
          `${apiUrl}/api/products/${encodeURIComponent(productId)}/reviews`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating, title, body }),
          },
        )

        if (!res.ok) throw new Error('Failed to submit review.')

        setSuccess(true)
        setTitle('')
        setBody('')
        setRating(5)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      } finally {
        setSubmitting(false)
      }
    },
    [productId, rating, title, body],
  )

  if (success) {
    return (
      <div className={styles.reviewsSection}>
        <h3 className={styles.reviewsTitle}>Write a Review</h3>
        <p style={{ fontSize: 'var(--nymbal-font-size-sm)', color: 'var(--nymbal-color-success)' }}>
          Thank you for your review! It has been submitted successfully.
        </p>
      </div>
    )
  }

  return (
    <div className={styles.reviewsSection}>
      <h3 className={styles.reviewsTitle}>Write a Review</h3>

      {error && (
        <p style={{ fontSize: 'var(--nymbal-font-size-sm)', color: 'var(--nymbal-color-error)', marginBottom: 'var(--nymbal-spacing-md)' }}>
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} data-testid="review-form">
        <div className="form-group">
          <label htmlFor="review-rating">Rating</label>
          <div className={styles.reviewStars} style={{ cursor: 'pointer', fontSize: '1.5rem' }}>
            {Array.from({ length: 5 }, (_, i) => (
              <span
                key={i}
                onClick={() => setRating(i + 1)}
                className={i < rating ? styles.starFilled : styles.starEmpty}
                role="button"
                tabIndex={0}
                aria-label={`Rate ${i + 1} star${i === 0 ? '' : 's'}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setRating(i + 1)
                }}
              >
                ★
              </span>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="review-title">Title</label>
          <input
            id="review-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder="Summarise your experience"
          />
        </div>
        <div className="form-group">
          <label htmlFor="review-body">Review</label>
          <textarea
            id="review-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            rows={4}
            placeholder="Tell us what you thought..."
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={submitting}
        >
          {submitting ? 'Submitting...' : 'Submit Review'}
        </button>
      </form>
    </div>
  )
}
