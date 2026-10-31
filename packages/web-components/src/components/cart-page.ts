import '@nymbalhq/sdk/ns/cart'
import { css, html, nothing } from 'lit'
import type { CartItem } from '@nymbalhq/types'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'
import { formatPrice } from '../format.js'
import { shownCart } from '../cart-projection.js'
import { NymbalQuantitySelector } from './quantity-selector.js'
import { buttonStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-cart-page',
  reactName: 'CartPage',
  // The cart a server read (cart-projection.ts), shown until the cart store settles.
  attributes: [{ name: 'cart', prop: 'cart', type: 'json' }],
  events: [],
  parts: [
    'loading',
    'empty',
    'empty-title',
    'empty-text',
    'continue',
    'layout',
    'header',
    'title',
    'count',
    'items',
    'item',
    'item-image',
    'item-info',
    'item-name',
    'item-variant',
    'item-price',
    'item-remove',
    'item-qty',
    'item-total',
    'summary',
    'summary-title',
    'summary-row',
    'subtotal',
    'total',
    'actions',
    'checkout',
  ],
  slots: ['title', 'empty', 'checkout-label'],
  children: false,
}

/** The cart as a page: its lines, quantities and removal, and a summary whose subtotal is the API's. */
export class NymbalCartPage extends NymbalElement {
  static override schema = SCHEMA
  static uses = [NymbalQuantitySelector]
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    buttonStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='loading'],
      [part~='empty'] {
        padding: 4rem var(--nymbal-spacing-md, 1rem);
        text-align: center;
      }
      /* Until the cart is known the page keeps what follows it below the fold, so a cart with lines does not push
         the footer down as it arrives. */
      [part~='loading'] {
        min-height: 100vh;
      }
      [part~='empty-title'] {
        margin: 0 0 var(--nymbal-spacing-xs, 0.25rem);
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='empty-text'] {
        margin: 0 0 var(--nymbal-spacing-lg, 1.5rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='layout'] {
        display: grid;
        grid-template-columns: 1fr;
        gap: var(--nymbal-spacing-xl, 2rem);
      }
      @media (min-width: 769px) {
        [part~='layout'] {
          grid-template-columns: 1fr 360px;
          align-items: start;
        }
      }
      [part~='header'] {
        margin-bottom: var(--nymbal-spacing-lg, 1.5rem);
      }
      [part~='title'] {
        margin: 0;
        font-size: 1.5rem;
        font-weight: var(--nymbal-font-weight-bold, 700);
        color: var(--nymbal-color-primary, #18181b);
      }
      [part~='count'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-normal, 400);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='items'] {
        display: flex;
        flex-direction: column;
      }
      [part~='item'] {
        display: grid;
        grid-template-columns: 80px 1fr auto;
        gap: var(--nymbal-spacing-md, 1rem);
        padding: var(--nymbal-spacing-md, 1rem) 0;
        border-bottom: 1px solid var(--nymbal-color-border, #e4e4e7);
        align-items: start;
      }
      [part~='item']:first-child {
        border-top: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      @media (min-width: 641px) {
        [part~='item'] {
          grid-template-columns: 100px 1fr auto auto;
          gap: var(--nymbal-spacing-lg, 1.5rem);
          align-items: center;
        }
      }
      [part~='item-image'] {
        display: block;
        width: 100%;
        aspect-ratio: 1 / 1;
        object-fit: cover;
        border-radius: var(--nymbal-radius-md, 0.5rem);
        background-color: #f4f4f5;
      }
      [part~='item-info'] {
        display: flex;
        flex-direction: column;
        gap: var(--nymbal-spacing-xs, 0.25rem);
        min-width: 0;
      }
      [part~='item-name'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
        color: var(--nymbal-color-text, #18181b);
        text-decoration: none;
      }
      [part~='item-name']:hover {
        color: var(--nymbal-color-accent, #2563eb);
      }
      [part~='item-variant'],
      [part~='item-price'] {
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='item-remove'] {
        align-self: start;
        padding: 0;
        font: inherit;
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        color: var(--nymbal-color-text-muted, #71717a);
        background: none;
        border: none;
        text-decoration: underline;
        cursor: pointer;
      }
      [part~='item-remove']:hover {
        color: var(--nymbal-color-error, #dc2626);
      }
      [part~='item-total'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        text-align: right;
        white-space: nowrap;
      }
      [part~='summary'] {
        position: sticky;
        top: 80px;
        padding: var(--nymbal-spacing-lg, 1.5rem);
        background-color: #fafafa;
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-lg, 0.75rem);
      }
      [part~='summary-title'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        padding-bottom: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        border-bottom: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      dl {
        margin: 0;
      }
      dd {
        margin: 0;
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='summary-row'] {
        display: flex;
        justify-content: space-between;
        padding: var(--nymbal-spacing-xs, 0.25rem) 0;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
      }
      [part~='summary-row'] dt {
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='total'] {
        display: flex;
        justify-content: space-between;
        margin-top: var(--nymbal-spacing-md, 1rem);
        padding-top: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        border-top: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      [part~='actions'] {
        display: flex;
        flex-direction: column;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        margin-top: var(--nymbal-spacing-lg, 1.5rem);
      }
    `,
  ]

  declare cart: unknown

  protected override stores() {
    return [this.client.cart]
  }

  protected override storeSettled(): void {
    this.cart = undefined
  }

  /** The first line's image is at the top of the page and is often its LCP, so only the lines below it load lazily. */
  private renderLine(item: CartItem, currency: string, index: number) {
    return html`
      <div part="item" data-testid="cart-item-${item.variantId}">
        ${item.imageUrl
          ? html`<img
              part="item-image"
              src=${item.imageUrl}
              alt=${item.productName}
              width="100"
              height="100"
              loading=${index === 0 ? 'eager' : 'lazy'}
            />`
          : html`<div part="item-image" aria-hidden="true"></div>`}
        <div part="item-info">
          <a part="item-name" href="/product/${encodeURIComponent(item.productId)}"
            >${item.productName}</a
          >
          ${item.variantName ? html`<span part="item-variant">${item.variantName}</span>` : nothing}
          <span part="item-price">${formatPrice(item.priceMinor, currency)} each</span>
          <button
            type="button"
            part="item-remove"
            data-testid="cart-remove-${item.variantId}"
            aria-label="Remove ${item.productName} from cart"
            @click=${() => void this.client.cart.removeItem(item.variantId)}
          >
            Remove
          </button>
        </div>
        <div part="item-qty">
          <nymbal-quantity-selector
            value=${item.qty}
            min="1"
            max="99"
            @nymbal:quantity:changed=${(e: CustomEvent<{ value: number }>) =>
              void this.client.cart.updateQuantity(item.variantId, e.detail.value)}
          ></nymbal-quantity-selector>
        </div>
        <span part="item-total">${formatPrice(item.priceMinor * item.qty, currency)}</span>
      </div>
    `
  }

  protected override render() {
    const state = shownCart(this, this.cart, this.readsStores ? this.client : null)
    const { items } = state
    const currency = state.currency || 'GBP'

    if (state.loading && items.length === 0) {
      return html`<div part="loading" role="status">Loading your cart...</div>`
    }
    if (items.length === 0) {
      return html`
        <div part="empty">
          <slot name="empty">
            <h1 part="empty-title">Your cart is empty</h1>
            <p part="empty-text">Looks like you haven't added anything yet.</p>
          </slot>
          <a part="continue" class="btn btn-primary" href="/products" data-testid="continue-shopping"
            >Continue Shopping</a
          >
        </div>
      `
    }

    const subtotal = formatPrice(state.subtotalMinor, currency)
    return html`
      <div part="layout">
        <div>
          <div part="header">
            <h1 part="title">
              <slot name="title">Your Cart</slot>
              <span part="count">(${items.length} ${items.length === 1 ? 'item' : 'items'})</span>
            </h1>
          </div>
          <div part="items" data-testid="cart-items">
            ${items.map((item, index) => this.renderLine(item, currency, index))}
          </div>
        </div>
        <div part="summary" data-testid="cart-summary">
          <h2 part="summary-title">Order Summary</h2>
          <dl>
            <div part="summary-row subtotal">
              <dt>Subtotal</dt>
              <dd>${subtotal}</dd>
            </div>
            <div part="summary-row">
              <dt>Shipping</dt>
              <dd>Calculated at checkout</dd>
            </div>
          </dl>
          <div part="total">
            <span>Estimated Total</span>
            <span>${subtotal}</span>
          </div>
          <div part="actions">
            <a part="checkout" class="btn btn-primary" href="/checkout" data-testid="checkout-btn"
              ><slot name="checkout-label">Proceed to Checkout</slot></a
            >
            <a part="continue" class="btn btn-secondary" href="/products">Continue Shopping</a>
          </div>
        </div>
      </div>
    `
  }
}
