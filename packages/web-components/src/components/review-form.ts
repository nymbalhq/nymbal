import '@nymbalhq/sdk/ns/auth'
import { css, html, nothing } from 'lit'
import { apiErrorCode } from '../api-error.js'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-review-form',
  reactName: 'ReviewForm',
  attributes: [{ name: 'product-id', prop: 'productId', type: 'string' }],
  events: [
    {
      name: 'nymbal:review:submitted',
      prop: 'onSubmitted',
      detail: '{ reviewId: string }',
    },
  ],
  parts: ['form', 'rating', 'title', 'body', 'submit', 'error', 'sign-in'],
  slots: [],
  children: false,
}

const GENERIC_FAILURE = 'Something went wrong. Please try again.'

const RATINGS: Array<[string, string]> = [
  ['5', '5 - Excellent'],
  ['4', '4 - Very Good'],
  ['3', '3 - Good'],
  ['2', '2 - Fair'],
  ['1', '1 - Poor'],
]

/**
 * A review of one product by the signed-in shopper: one submission per click, the form cleared once the store has it.
 * A shopper known to be signed out gets a link to sign in and come back instead; until the session is known (a server
 * render, the profile still loading) it is the form.
 */
export class NymbalReviewForm extends NymbalFormElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    buttonStyles,
    fieldStyles,
    css`
      :host {
        max-width: 32rem;
      }
      h3 {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        line-height: 1.2;
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      label {
        display: block;
        margin-bottom: var(--nymbal-spacing-xs, 0.25rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='rating'],
      [part~='title'],
      [part~='body'] {
        display: block;
        width: 100%;
        margin-bottom: var(--nymbal-spacing-md, 1rem);
        padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
        font: inherit;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text, #18181b);
        background-color: var(--nymbal-color-surface, #ffffff);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-md, 0.5rem);
      }
      [part~='body'] {
        resize: vertical;
      }
      [part~='sign-in'] {
        font-weight: var(--nymbal-font-weight-medium, 500);
        color: var(--nymbal-color-primary, #18181b);
      }
      .notice {
        margin-top: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-success, #16a34a);
      }
    `,
  ]

  declare productId: string | undefined

  /** The session restore this element asked for: the shopper is known to be signed out only once it has settled. */
  private profile: 'unasked' | 'loading' | 'loaded' = 'unasked'
  /** The store refused a submission for want of a session. */
  private sessionEnded = false

  protected override stores() {
    return [this.client.auth]
  }

  protected override clientConnected(): void {
    if (this.profile !== 'unasked' || this.client.auth.getState().isAuthenticated) return
    this.profile = 'loading'
    void this.client.auth.restore().then(() => {
      this.profile = 'loaded'
      this.requestUpdate()
    })
  }

  private get signedOut(): boolean {
    if (!this.readsStores) return false
    if (this.sessionEnded) return true
    return this.profile === 'loaded' && !this.client.auth.getState().isAuthenticated
  }

  protected override async send(): Promise<void> {
    const answer: { review?: { id: string } | null } | null | undefined =
      await this.client.adapter.reviews
        .submit({
          productId: this.productId ?? '',
          rating: Number(this.value('rating')),
          title: this.value('title'),
          body: this.value('body'),
        })
        .catch((err: unknown) => {
          // The session ended: the shopper signs in again rather than submitting again.
          if (apiErrorCode(err) === 'auth.unauthorized') this.sessionEnded = true
          throw err
        })
    this.renderRoot.querySelector('form')?.reset()
    this.notice = 'Thank you! Your review will appear once it is approved.'
    // A 2xx answer is the store's acceptance; without a review in it there is no id to announce.
    const reviewId = answer?.review?.id
    if (reviewId !== undefined) this.emit('nymbal:review:submitted', { reviewId })
  }

  /** The store's own words for a refusal of the review or the session; anything else (the network) is generic. */
  protected override failureText(err: unknown): string {
    const code = apiErrorCode(err)
    const own = code !== undefined && (code.startsWith('reviews.') || code.startsWith('auth.'))
    return own && err instanceof Error && err.message !== '' ? err.message : GENERIC_FAILURE
  }

  protected override render() {
    if (this.signedOut) {
      const redirect = encodeURIComponent(location.pathname)
      return html`
        ${this.renderError()}
        <a part="sign-in" data-testid="review-sign-in" href=${`/account/login?redirect=${redirect}`}
          >Sign in to write a review</a
        >
      `
    }
    return html`
      ${this.renderError()}
      <form part="form" data-testid="review-form" @submit=${this.onSubmit}>
        <h3>Write a Review</h3>
        <label for="review-rating">Rating</label>
        <select part="rating" id="review-rating" name="rating" required data-testid="review-rating">
          <option value="">Select a rating</option>
          ${RATINGS.map(([value, label]) => html`<option value=${value}>${label}</option>`)}
        </select>
        <label for="review-title">Title</label>
        <input
          part="title"
          id="review-title"
          name="title"
          type="text"
          placeholder="Summarise your experience"
          required
          data-testid="review-title"
        />
        <label for="review-body">Review</label>
        <textarea
          part="body"
          id="review-body"
          name="body"
          rows="4"
          placeholder="Tell us what you think..."
          required
          data-testid="review-body"
        ></textarea>
        <button
          type="submit"
          part="submit"
          class="btn btn-primary"
          data-testid="review-submit"
          ?disabled=${this.pending}
        >
          ${this.pending ? 'Submitting...' : 'Submit Review'}
        </button>
        ${this.notice === null ? nothing : html`<p class="notice" role="status">${this.notice}</p>`}
      </form>
    `
  }
}
