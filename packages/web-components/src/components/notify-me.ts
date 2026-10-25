import { css, html, nothing } from 'lit'
import type { AlertKind } from '@nymbalhq/types'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { renderField } from '../form-element.js'
import { NymbalVariantElement } from '../selected-variant.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-notify-me',
  reactName: 'NotifyMe',
  // The product's first variant and its stock as a server read them; the product store's selected variant once it
  // holds this product.
  attributes: [
    { name: 'product-id', prop: 'productId', type: 'string' },
    { name: 'variant-id', prop: 'variantId', type: 'string' },
    { name: 'stock', prop: 'stock', type: 'number' },
  ],
  events: [
    {
      name: 'nymbal:alert:requested',
      prop: 'onRequested',
      detail: '{ kind: AlertKind; variantId: string }',
    },
  ],
  parts: ['form', 'heading', 'field', 'label', 'input', 'submit', 'notice', 'error'],
  slots: [],
  children: false,
}

const KIND: AlertKind = 'back_in_stock'
const NOTICE = 'Check your inbox to confirm.'

/**
 * An out-of-stock variant's "email me when it's back" form, for the variant the page shows; an in-stock one renders
 * nothing. One subscribe per submission: `requestSubmit()` and Enter fire `submit` while the button is disabled, so the
 * pending flag, not the button, is the guard (as `NymbalFormElement`'s). An accepted request stays accepted for its
 * variant, so a second click cannot send a second confirmation.
 */
export class NymbalNotifyMe extends NymbalVariantElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    buttonStyles,
    fieldStyles,
    css`
      :host {
        display: block;
        max-width: 32rem;
      }
      [part~='heading'] {
        margin: 0 0 var(--nymbal-spacing-sm, 0.5rem);
        font-size: var(--nymbal-font-size-md, 1rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='notice'] {
        margin-top: var(--nymbal-spacing-sm, 0.5rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-success, #16a34a);
      }
      [part~='error'] {
        margin-top: var(--nymbal-spacing-sm, 0.5rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-error, #dc2626);
      }
    `,
  ]

  declare variantId: string | undefined
  declare stock: number | undefined

  private pending = false
  private error: string | null = null
  /** The variant an accepted request was for. */
  private acceptedFor: string | undefined

  /** The variant the form is for and its stock: the store's selected one once it holds this product. */
  private followed(): { variantId: string | undefined; stock: number | undefined } {
    const store = this.selected()
    if (store === null) return { variantId: this.variantId, stock: this.stock }
    return { variantId: store.variant?.id, stock: store.variant?.stock ?? 0 }
  }

  private readonly onSubmit = (event: Event): void => {
    event.preventDefault()
    const { variantId } = this.followed()
    if (this.pending || variantId === undefined || this.acceptedFor === variantId) return
    this.pending = true
    this.error = null
    const email = this.renderRoot.querySelector<HTMLInputElement>('[name="email"]')?.value ?? ''
    const sent = this.client.adapter.alerts.subscribe({ email, variantId, kind: KIND })
    this.requestUpdate()
    sent.then(
      () => {
        this.pending = false
        this.acceptedFor = variantId
        this.requestUpdate()
        this.dispatchEvent(
          new CustomEvent('nymbal:alert:requested', {
            bubbles: true,
            composed: true,
            detail: { kind: KIND, variantId },
          }),
        )
      },
      () => {
        this.pending = false
        this.error = 'Something went wrong. Please try again.'
        this.requestUpdate()
      },
    )
  }

  protected override render() {
    const { variantId, stock } = this.followed()
    if (stock === undefined || Number.isNaN(stock) || stock > 0) return nothing
    const accepted = variantId !== undefined && this.acceptedFor === variantId
    return html`
      <form part="form" data-testid="notify-me" data-kind=${KIND} @submit=${this.onSubmit}>
        <h3 part="heading">Email me when it's back</h3>
        ${renderField({
          id: 'notify-me-email',
          name: 'email',
          label: 'Email',
          type: 'email',
          autocomplete: 'email',
          required: true,
          placeholder: 'you@example.com',
        })}
        <button
          type="submit"
          part="submit"
          class="btn btn-primary"
          data-testid="notify-me-submit"
          ?disabled=${this.pending || accepted}
        >
          Notify me
        </button>
        ${accepted
          ? html`<p part="notice" role="status" data-testid="notify-me-notice">${NOTICE}</p>`
          : nothing}
        ${this.error === null
          ? nothing
          : html`<p part="error" role="alert" data-testid="notify-me-error">${this.error}</p>`}
      </form>
    `
  }
}
