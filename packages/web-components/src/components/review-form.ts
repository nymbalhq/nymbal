import { css, html, nothing } from 'lit'
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
  parts: ['form', 'rating', 'title', 'body', 'submit', 'error'],
  slots: [],
  children: false,
}

const RATINGS: Array<[string, string]> = [
  ['5', '5 - Excellent'],
  ['4', '4 - Very Good'],
  ['3', '3 - Good'],
  ['2', '2 - Fair'],
  ['1', '1 - Poor'],
]

/** A review of one product: one submission per click, the form cleared once the store has it. */
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
      .notice {
        margin-top: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-success, #16a34a);
      }
    `,
  ]

  declare productId: string | undefined

  protected override async send(): Promise<void> {
    const { review } = await this.client.adapter.reviews.submit({
      productId: this.productId ?? '',
      rating: Number(this.value('rating')),
      title: this.value('title'),
      body: this.value('body'),
    })
    this.renderRoot.querySelector('form')?.reset()
    this.notice = 'Thank you for your review!'
    this.emit('nymbal:review:submitted', { reviewId: review.id })
  }

  protected override failureText(): string {
    return 'Something went wrong. Please try again.'
  }

  protected override render() {
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
