import { NymbalElement } from '../base-element.js'
import { injectStyles } from '../styles.js'

const STYLES = `
nymbal-cart-drawer {
  display: block;
}
nymbal-cart-drawer .nymbal-drawer-overlay {
  position: fixed;
  inset: 0;
  background: var(--nymbal-color-overlay);
  z-index: var(--nymbal-z-drawer);
  opacity: 0;
  visibility: hidden;
  transition: opacity var(--nymbal-transition-normal), visibility var(--nymbal-transition-normal);
}
nymbal-cart-drawer[open] .nymbal-drawer-overlay {
  opacity: 1;
  visibility: visible;
}
nymbal-cart-drawer .nymbal-drawer-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(400px, 90vw);
  background: var(--nymbal-color-surface);
  z-index: var(--nymbal-z-drawer);
  transform: translateX(100%);
  transition: transform var(--nymbal-transition-normal);
  display: flex;
  flex-direction: column;
  font-family: var(--nymbal-font-family);
}
nymbal-cart-drawer[open] .nymbal-drawer-panel {
  transform: translateX(0);
}
nymbal-cart-drawer .nymbal-drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--nymbal-spacing-md) var(--nymbal-spacing-lg);
  border-bottom: 1px solid var(--nymbal-color-border);
}
nymbal-cart-drawer .nymbal-drawer-header h2 {
  margin: 0;
  font-size: var(--nymbal-font-size-lg);
  font-weight: var(--nymbal-font-weight-bold);
}
nymbal-cart-drawer .nymbal-drawer-close {
  background: none;
  border: none;
  font-size: var(--nymbal-font-size-xl);
  cursor: pointer;
  padding: var(--nymbal-spacing-xs);
  color: var(--nymbal-color-text-muted);
}
nymbal-cart-drawer .nymbal-drawer-items {
  flex: 1;
  overflow-y: auto;
  padding: var(--nymbal-spacing-md) var(--nymbal-spacing-lg);
}
nymbal-cart-drawer .nymbal-cart-item {
  display: flex;
  gap: var(--nymbal-spacing-md);
  padding: var(--nymbal-spacing-md) 0;
  border-bottom: 1px solid var(--nymbal-color-border);
}
nymbal-cart-drawer .nymbal-cart-item-info {
  flex: 1;
}
nymbal-cart-drawer .nymbal-cart-item-name {
  font-weight: var(--nymbal-font-weight-medium);
  margin-bottom: var(--nymbal-spacing-xs);
}
nymbal-cart-drawer .nymbal-cart-item-variant {
  font-size: var(--nymbal-font-size-sm);
  color: var(--nymbal-color-text-muted);
}
nymbal-cart-drawer .nymbal-cart-item-actions {
  display: flex;
  align-items: center;
  gap: var(--nymbal-spacing-sm);
}
nymbal-cart-drawer .nymbal-cart-item-remove {
  background: none;
  border: none;
  color: var(--nymbal-color-error);
  cursor: pointer;
  font-size: var(--nymbal-font-size-sm);
  padding: var(--nymbal-spacing-xs);
}
nymbal-cart-drawer .nymbal-drawer-footer {
  padding: var(--nymbal-spacing-md) var(--nymbal-spacing-lg);
  border-top: 1px solid var(--nymbal-color-border);
}
nymbal-cart-drawer .nymbal-cart-subtotal {
  display: flex;
  justify-content: space-between;
  font-weight: var(--nymbal-font-weight-bold);
  margin-bottom: var(--nymbal-spacing-md);
}
nymbal-cart-drawer .nymbal-checkout-btn {
  width: 100%;
  font-family: var(--nymbal-font-family);
  font-size: var(--nymbal-font-size-base);
  font-weight: var(--nymbal-font-weight-medium);
  background: var(--nymbal-color-primary);
  color: var(--nymbal-color-text-inverse);
  border: none;
  border-radius: var(--nymbal-radius-md);
  padding: var(--nymbal-spacing-sm) var(--nymbal-spacing-lg);
  cursor: pointer;
  transition: background var(--nymbal-transition-fast);
}
nymbal-cart-drawer .nymbal-checkout-btn:hover {
  background: var(--nymbal-color-primary-hover);
}
nymbal-cart-drawer .nymbal-drawer-empty {
  text-align: center;
  color: var(--nymbal-color-text-muted);
  padding: var(--nymbal-spacing-xl) 0;
}
`

export class NymbalCartDrawer extends NymbalElement {
  static get observedAttributes(): string[] {
    return ['open']
  }

  private readonly handleItemAdded = (): void => {
    this.open()
  }

  private readonly handleMiniCartClicked = (): void => {
    this.toggle()
  }

  protected setup(): void {
    injectStyles('nymbal-cart-drawer', STYLES)
    this.subscribeToStore(this.client.cart)
    document.addEventListener('nymbal:cart:item-added', this.handleItemAdded)
    document.addEventListener('nymbal:mini-cart:clicked', this.handleMiniCartClicked)
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    document.removeEventListener('nymbal:cart:item-added', this.handleItemAdded)
    document.removeEventListener('nymbal:mini-cart:clicked', this.handleMiniCartClicked)
  }

  open(): void {
    this.setAttribute('open', '')
    window.dispatchEvent(new CustomEvent('nymbal:cart:open'))
  }

  close(): void {
    this.removeAttribute('open')
    window.dispatchEvent(new CustomEvent('nymbal:cart:close'))
  }

  toggle(): void {
    if (this.hasAttribute('open')) {
      this.close()
    } else {
      this.open()
    }
  }

  protected render(): void {
    const state = this.client.cart.getState()
    const currency = state.currency

    const itemsHtml = state.items.length === 0
      ? `<div class="nymbal-drawer-empty">Your cart is empty</div>`
      : state.items.map((item) => `
        <div class="nymbal-cart-item" data-testid="cart-item-${item.variantId}">
          <div class="nymbal-cart-item-info">
            <div class="nymbal-cart-item-name">${this.esc(item.productName)}</div>
            <div class="nymbal-cart-item-variant">${this.esc(item.variantName)}</div>
            <div class="nymbal-cart-item-qty">Qty: ${item.qty}</div>
          </div>
          <div class="nymbal-cart-item-actions">
            <span>${this.formatPrice(item.priceMinor * item.qty, currency)}</span>
            <button type="button" class="nymbal-cart-item-remove" data-testid="remove-item-${item.variantId}" data-variant-id="${item.variantId}">Remove</button>
          </div>
        </div>
      `).join('')

    this.innerHTML = `
      <div class="nymbal-drawer-overlay" data-testid="cart-drawer-overlay"></div>
      <div class="nymbal-drawer-panel" role="dialog" aria-label="Shopping cart" aria-modal="true" data-testid="cart-drawer">
        <div class="nymbal-drawer-header">
          <h2>Cart (${state.itemCount})</h2>
          <button type="button" class="nymbal-drawer-close" data-testid="cart-drawer-close" aria-label="Close cart">&times;</button>
        </div>
        <div class="nymbal-drawer-items">${itemsHtml}</div>
        ${state.items.length > 0 ? `
          <div class="nymbal-drawer-footer">
            <div class="nymbal-cart-subtotal">
              <span>Subtotal</span>
              <span>${this.formatPrice(state.subtotalMinor, currency)}</span>
            </div>
            <button type="button" class="nymbal-checkout-btn" data-testid="cart-checkout-btn">Checkout</button>
          </div>
        ` : ''}
      </div>
    `

    this.querySelector('.nymbal-drawer-overlay')?.addEventListener('click', () => this.close())
    this.querySelector('.nymbal-drawer-close')?.addEventListener('click', () => this.close())
    this.querySelector('.nymbal-checkout-btn')?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('nymbal:cart:checkout-clicked', { bubbles: true, composed: true }))
    })
    this.querySelectorAll('.nymbal-cart-item-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const variantId = (btn as HTMLElement).dataset['variantId']
        if (variantId) this.client.cart.removeItem(variantId)
      })
    })
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.requestRender()
  }

  private esc(str: string): string {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  private formatPrice(minor: number, currency: string): string {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(minor / 100)
  }
}
