import { NymbalElement } from '../base-element.js'
import { injectStyles } from '../styles.js'

const STYLES = `
nymbal-mini-cart {
  display: inline-block;
  position: relative;
}
nymbal-mini-cart button {
  background: none;
  border: none;
  cursor: pointer;
  position: relative;
  padding: var(--nymbal-spacing-sm);
  font-family: var(--nymbal-font-family);
  color: var(--nymbal-color-text);
}
nymbal-mini-cart .nymbal-mini-cart-icon {
  width: 24px;
  height: 24px;
}
nymbal-mini-cart .nymbal-mini-cart-badge {
  position: absolute;
  top: 0;
  right: 0;
  background: var(--nymbal-color-accent);
  color: var(--nymbal-color-text-inverse);
  font-size: var(--nymbal-font-size-xs);
  font-weight: var(--nymbal-font-weight-bold);
  min-width: 18px;
  height: 18px;
  border-radius: var(--nymbal-radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
nymbal-mini-cart .nymbal-mini-cart-badge:empty {
  display: none;
}
`

const CART_SVG = `<svg class="nymbal-mini-cart-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`

export class NymbalMiniCart extends NymbalElement {
  protected setup(): void {
    injectStyles('nymbal-mini-cart', STYLES)
    this.subscribeToStore(this.client.cart)
  }

  protected render(): void {
    const { itemCount } = this.client.cart.getState()

    this.innerHTML = `
      <button data-testid="mini-cart" aria-label="Cart (${itemCount} items)">
        ${CART_SVG}
        <span class="nymbal-mini-cart-badge">${itemCount > 0 ? itemCount : ''}</span>
      </button>
    `

    this.querySelector('button')?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('nymbal:mini-cart:clicked', { bubbles: true, composed: true }))
    })
  }
}
