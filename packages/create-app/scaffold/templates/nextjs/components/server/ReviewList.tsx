import { formatDate } from '@/lib/format'
import styles from '@/styles/pages/pdp.module.css'

interface Review {
  id: string
  productId: string
  rating: number
  title: string
  body: string
  submittedAt: string
}

interface ReviewListProps {
  reviews: Review[]
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className={styles.reviewStars} aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={i < rating ? styles.starFilled : styles.starEmpty}
          aria-hidden="true"
        >
          ★
        </span>
      ))}
    </div>
  )
}

export function ReviewList({ reviews }: ReviewListProps) {
  if (reviews.length === 0) {
    return (
      <div className={styles.reviewsSection}>
        <h2 className={styles.reviewsTitle}>Reviews</h2>
        <p className={styles.noReviews}>No reviews yet. Be the first to leave a review.</p>
      </div>
    )
  }

  return (
    <div className={styles.reviewsSection}>
      <h2 className={styles.reviewsTitle}>Reviews ({reviews.length})</h2>
      <div className={styles.reviewsList}>
        {reviews.map((review) => (
          <article key={review.id} className={styles.reviewCard}>
            <div className={styles.reviewHeader}>
              <StarRating rating={review.rating} />
              <time className={styles.reviewDate} dateTime={review.submittedAt}>
                {formatDate(review.submittedAt)}
              </time>
            </div>
            {review.title && <h3 className={styles.reviewTitle}>{review.title}</h3>}
            <p className={styles.reviewBody}>{review.body}</p>
          </article>
        ))}
      </div>
    </div>
  )
}
