import { css, html, nothing } from 'lit'
import type { ProductRating } from '@nymbalhq/types'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'
import { reviewsOf, shownRating, stars } from '../rating.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-review-list',
  reactName: 'ReviewList',
  // A product's approved reviews, as `GET /api/products/:id/reviews` serves them, and its `rating` as the product
  // routes serve it.
  attributes: [
    { name: 'reviews', prop: 'reviews', type: 'json' },
    { name: 'rating', prop: 'rating', type: 'json' },
  ],
  events: [],
  parts: ['summary', 'list', 'review', 'rating', 'empty'],
  slots: ['empty'],
  children: false,
}

interface Review {
  id: string
  rating: number
  title: string
  body: string
  submittedAt: string
}

// UTC, so the server's date and the browser's are one.
const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

function dateOf(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : DATE.format(date)
}

/** The product's stars, average and review count, above its reviews. */
function summaryOf(r: ProductRating | null) {
  if (r === null) return nothing
  return html`<p part="summary">
    <span class="stars" aria-hidden="true">${stars(r.average)}</span>
    ${r.average.toFixed(1)} out of 5 · ${reviewsOf(r.count)}
  </p>`
}

/**
 * A product's rating summary, then its reviews, each with its rating, date, title and text; an invitation when there
 * are none.
 */
export class NymbalReviewList extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='list'] {
        display: flex;
        flex-direction: column;
        gap: var(--nymbal-spacing-lg, 1.5rem);
      }
      [part~='review'] {
        padding-bottom: var(--nymbal-spacing-lg, 1.5rem);
        border-bottom: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      .meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--nymbal-spacing-sm, 0.5rem);
      }
      [part~='summary'] {
        margin: 0 0 var(--nymbal-spacing-lg, 1.5rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='rating'],
      .stars {
        letter-spacing: 0.1em;
        color: var(--nymbal-color-warning, #d97706);
      }
      .date {
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      h3 {
        margin: 0 0 var(--nymbal-spacing-xs, 0.25rem);
        line-height: 1.2;
        font-size: var(--nymbal-font-size-base, 1rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      p {
        margin: 0;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        line-height: 1.6;
        color: var(--nymbal-color-text-muted, #71717a);
      }
    `,
  ]

  declare reviews: unknown
  declare rating: unknown

  protected override render() {
    const reviews = parsedJson<Review[]>(this, 'reviews', this.reviews)
    const summary = summaryOf(shownRating(parsedJson<unknown>(this, 'rating', this.rating)))
    if (!Array.isArray(reviews) || reviews.length === 0) {
      return html`${summary}<p part="empty">
          <slot name="empty">No reviews yet. Be the first to review this product.</slot>
        </p>`
    }
    return html`
      ${summary}
      <div part="list" data-testid="review-list">
        ${reviews.map(
          (r) => html`
            <article part="review" data-testid="review-${r.id}">
              <div class="meta">
                <span part="rating" aria-label="${r.rating} out of 5 stars"
                  >${stars(r.rating)}</span
                >
                <span class="date">${dateOf(r.submittedAt)}</span>
              </div>
              <h3>${r.title}</h3>
              <p>${r.body}</p>
            </article>
          `,
        )}
      </div>
    `
  }
}
