import { css, html, nothing } from 'lit'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-cart-drawer',
  reactName: 'CartDrawer',
  attributes: [{ name: 'open', prop: 'open', type: 'boolean' }],
  events: [{ name: 'nymbal:cart:checkout-clicked', prop: 'onCheckoutClick', detail: 'void' }],
  parts: [
    'overlay',
    'panel',
    'header',
    'title',
    'close',
    'items',
    'empty',
    'item',
    'item-info',
    'item-name',
    'item-variant',
    'item-qty',
    'item-actions',
    'item-price',
    'item-remove',
    'footer',
    'subtotal',
    'checkout',
  ],
  slots: ['title', 'empty', 'checkout-label'],
  children: false,
}

function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100)
}

export class NymbalCartDrawer extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }
      [part~='overlay'] {
        position: fixed;
        inset: 0;
        background: var(--nymbal-color-overlay, rgba(0, 0, 0, 0.4));
        z-index: var(--nymbal-z-drawer, 200);
        opacity: 0;
        visibility: hidden;
        transition:
          opacity var(--nymbal-transition-normal, 200ms ease),
          visibility var(--nymbal-transition-normal, 200ms ease);
      }
      :host([open]) [part~='overlay'] {
        opacity: 1;
        visibility: visible;
      }
      [part~='panel'] {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(400px, 90vw);
        background: var(--nymbal-color-surface, #ffffff);
        z-index: var(--nymbal-z-drawer, 200);
        transform: translateX(100%);
        transition: transform var(--nymbal-transition-normal, 200ms ease);
        display: flex;
        flex-direction: column;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      :host([open]) [part~='panel'] {
        transform: translateX(0);
      }
      [part~='header'] {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--nymbal-spacing-md, 1rem) var(--nymbal-spacing-lg, 1.5rem);
        border-bottom: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      [part~='title'] {
        margin: 0;
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='close'] {
        background: none;
        border: none;
        font-size: var(--nymbal-font-size-xl, 1.25rem);
        cursor: pointer;
        padding: var(--nymbal-spacing-xs, 0.25rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='items'] {
        flex: 1;
        overflow-y: auto;
        padding: var(--nymbal-spacing-md, 1rem) var(--nymbal-spacing-lg, 1.5rem);
      }
      [part~='item'] {
        display: flex;
        gap: var(--nymbal-spacing-md, 1rem);
        padding: var(--nymbal-spacing-md, 1rem) 0;
        border-bottom: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      [part~='item-info'] {
        flex: 1;
      }
      [part~='item-name'] {
        font-weight: var(--nymbal-font-weight-medium, 500);
        margin-bottom: var(--nymbal-spacing-xs, 0.25rem);
      }
      [part~='item-variant'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='item-actions'] {
        display: flex;
        align-items: center;
        gap: var(--nymbal-spacing-sm, 0.5rem);
      }
      [part~='item-remove'] {
        background: none;
        border: none;
        color: var(--nymbal-color-error, #dc2626);
        cursor: pointer;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        padding: var(--nymbal-spacing-xs, 0.25rem);
      }
      [part~='footer'] {
        padding: var(--nymbal-spacing-md, 1rem) var(--nymbal-spacing-lg, 1.5rem);
        border-top: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      [part~='subtotal'] {
        display: flex;
        justify-content: space-between;
        font-weight: var(--nymbal-font-weight-bold, 700);
        margin-bottom: var(--nymbal-spacing-md, 1rem);
      }
      [part~='checkout'] {
        width: 100%;
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
      }
      [part~='checkout']:hover {
        background: var(--nymbal-color-primary-hover, #27272a);
      }
      [part~='empty'] {
        text-align: center;
        color: var(--nymbal-color-text-muted, #71717a);
        padding: var(--nymbal-spacing-xl, 2rem) 0;
      }
    `,
  ]

  private readonly handleItemAdded = (): void => {
    this.show()
  }

  private readonly handleMiniCartClicked = (): void => {
    this.toggle()
  }

  protected override stores() {
    return [this.client.cart]
  }

  override connectedCallback(): void {
    super.connectedCallback()
    document.addEventListener('nymbal:cart:item-added', this.handleItemAdded)
    document.addEventListener('nymbal:mini-cart:clicked', this.handleMiniCartClicked)
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    document.removeEventListener('nymbal:cart:item-added', this.handleItemAdded)
    document.removeEventListener('nymbal:mini-cart:clicked', this.handleMiniCartClicked)
  }

  /** Opens the drawer (the `open` attribute and property say whether it is). */
  show(): void {
    this.setAttribute('open', '')
    window.dispatchEvent(new CustomEvent('nymbal:cart:open'))
  }

  hide(): void {
    this.removeAttribute('open')
    window.dispatchEvent(new CustomEvent('nymbal:cart:close'))
  }

  toggle(): void {
    if (this.hasAttribute('open')) {
      this.hide()
    } else {
      this.show()
    }
  }

  protected override render() {
    const state = this.client.cart.getState()
    const currency = state.currency

    const items =
      state.items.length === 0
        ? html`<div part="empty"><slot name="empty">Your cart is empty</slot></div>`
        : state.items.map(
            (item) => html`
              <div part="item" data-testid="cart-item-${item.variantId}">
                <div part="item-info">
                  <div part="item-name">${item.productName}</div>
                  <div part="item-variant">${item.variantName}</div>
                  <div part="item-qty">Qty: ${item.qty}</div>
                </div>
                <div part="item-actions">
                  <span part="item-price">${formatPrice(item.priceMinor * item.qty, currency)}</span>
                  <button
                    type="button"
                    part="item-remove"
                    data-testid="remove-item-${item.variantId}"
                    @click=${() => void this.client.cart.removeItem(item.variantId)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            `,
          )

    return html`
      <div part="overlay" data-testid="cart-drawer-overlay" @click=${() => this.hide()}></div>
      <div
        part="panel"
        role="dialog"
        aria-label="Shopping cart"
        aria-modal="true"
        data-testid="cart-drawer"
      >
        <div part="header">
          <h2 part="title"><slot name="title">Cart (${state.itemCount})</slot></h2>
          <button
            type="button"
            part="close"
            data-testid="cart-drawer-close"
            aria-label="Close cart"
            @click=${() => this.hide()}
          >
            &times;
          </button>
        </div>
        <div part="items">${items}</div>
        ${state.items.length > 0
          ? html`
              <div part="footer">
                <div part="subtotal">
                  <span>Subtotal</span>
                  <span>${formatPrice(state.subtotalMinor, currency)}</span>
                </div>
                <button
                  type="button"
                  part="checkout"
                  data-testid="cart-checkout-btn"
                  @click=${this.handleCheckout}
                >
                  <slot name="checkout-label">Checkout</slot>
                </button>
              </div>
            `
          : nothing}
      </div>
    `
  }

  private handleCheckout = (): void => {
    this.dispatchEvent(
      new CustomEvent('nymbal:cart:checkout-clicked', { bubbles: true, composed: true }),
    )
  }
}
