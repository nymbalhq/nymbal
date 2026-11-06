import type { ProductRating } from '@nymbalhq/types'

/** Five stars, `Math.round(rating)` of them filled, clamped to 0..5. */
export function stars(rating: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(rating)))
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

/** The rating when there is one to show: a served rating with at least one review. */
export function shownRating(value: unknown): ProductRating | null {
  if (value === null || typeof value !== 'object') return null
  const { average, count } = value as Partial<ProductRating>
  return typeof average === 'number' && typeof count === 'number' && count > 0
    ? { average, count }
    : null
}

/** "2 reviews", "1 review". */
export function reviewsOf(count: number): string {
  return `${count} ${count === 1 ? 'review' : 'reviews'}`
}
