import '@nymbalhq/sdk/ns/cart'
import { css, html, type PropertyValues } from 'lit'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'

const MIN_QTY = 1
const MAX_QTY = 99

/** The `qty` attribute as a whole number of units: a non-integer is 1, and the result is clamped to 1-99. */
function quantityOf(attr: string | null): number {
  const n = attr === null || attr.trim() === '' ? Number.NaN : Number(attr)
  const whole = Number.isInteger(n) ? n : MIN_QTY
  return Math.min(MAX_QTY, Math.max(MIN_QTY, whole))
}

const LIMIT_MESSAGE = `You can have at most ${MAX_QTY} of this item in your cart.`
const GENERAL_MESSAGE = 'This item could not be added. Please try again.'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-add-to-cart',
  reactName: 'AddToCart',
  attributes: [
    { name: 'variant-id', prop: 'variantId', type: 'string' },
    { name: 'qty', prop: 'qty', type: 'number' },
    { name: 'disabled', prop: 'disabled', type: 'boolean' },
  ],
  events: [
    {
      name: 'nymbal:cart:item-added',
      prop: 'onItemAdded',
      detail: '{ variantId: string; qty: number }',
    },
  ],
  parts: ['button', 'error'],
  slots: ['label', 'loading-label'],
  children: true,
}

export class NymbalAddToCart extends NymbalElement {
  static override schema = SCHEMA
  static override properties = { ...propertiesOf(SCHEMA), refusal: { state: true } }

  static override styles = [
    baseStyles,
    css`
      :host {
        display: inline-block;
      }
      [part~='button'] {
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        font-size: var(--nymbal-font-size-base, 1rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
        background: var(--nymbal-color-primary, #18181b);
        color: var(--nymbal-color-text-inverse, #ffffff);
        border: none;
        border-radius: var(--nymbal-radius-md, 0.375rem);
        padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-lg, 1.5rem);
        cursor: pointer;
        transition: background var(--nymbal-transition-fast, 150ms ease);
        min-width: 140px;
      }
      [part~='button']:hover:not(:disabled) {
        background: var(--nymbal-color-primary-hover, #27272a);
      }
      [part~='button']:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      [part~='error'] {
        margin: var(--nymbal-spacing-xs, 0.25rem) 0 0;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-error, #dc2626);
      }
    `,
  ]

  /** Why this element's last add was refused; the cart store's `error` is shared by every add-to-cart on the page. */
  declare private refusal: string | null

  constructor() {
    super()
    this.refusal = null
  }

  protected override stores() {
    return [this.client.cart]
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed)
    if (changed.has('variantId') && changed.get('variantId') !== undefined) this.refusal = null
  }

  protected override render() {
    const variantId = this.getAttribute('variant-id')
    // Until it reads the cart store (a server render, and the first render taking that over) the cart is not adding.
    const loading = this.readsStores && this.client.cart.getState().loading
    return html`<button
        type="button"
        part="button"
        data-testid="add-to-cart"
        ?disabled=${this.hasAttribute('disabled') || loading || !variantId}
        aria-busy=${String(loading)}
        @click=${this.handleClick}
      >
        ${loading
          ? html`<slot name="loading-label">Adding...</slot>`
          : html`<slot name="label">Add to Cart</slot>`}</button
      >${this.refusal === null
        ? null
        : html`<p part="error" role="alert" data-testid="add-to-cart-error">${this.refusal}</p>`}`
  }

  private handleClick = async (): Promise<void> => {
    const variantId = this.getAttribute('variant-id')
    if (!variantId) return
    const qty = quantityOf(this.getAttribute('qty'))
    this.refusal = null
    try {
      await this.client.cart.addItem(variantId, qty)
    } catch {
      this.refusal = GENERAL_MESSAGE
      return
    }
    // `addItem` resolves on a refusal too, leaving it in the store's `error`.
    const { error, errorCode } = this.client.cart.getState()
    if (error !== null) {
      this.refusal = errorCode === 'cart.qty_limit' ? LIMIT_MESSAGE : GENERAL_MESSAGE
      return
    }
    this.dispatchEvent(
      new CustomEvent('nymbal:cart:item-added', {
        bubbles: true,
        composed: true,
        detail: { variantId, qty },
      }),
    )
  }
}
