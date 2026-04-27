import { NymbalElement } from '../base-element.js'
import { injectStyles } from '../styles.js'

const STYLES = `
nymbal-add-to-cart {
  display: inline-block;
}
nymbal-add-to-cart button {
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
  min-width: 140px;
}
nymbal-add-to-cart button:hover:not(:disabled) {
  background: var(--nymbal-color-primary-hover);
}
nymbal-add-to-cart button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`

export class NymbalAddToCart extends NymbalElement {
  static get observedAttributes(): string[] {
    return ['variant-id', 'disabled']
  }

  private button!: HTMLButtonElement

  protected setup(): void {
    injectStyles('nymbal-add-to-cart', STYLES)
    this.subscribeToStore(this.client.cart)
  }

  protected render(): void {
    const variantId = this.getAttribute('variant-id')
    const isDisabled = this.hasAttribute('disabled')
    const cartState = this.client.cart.getState()

    if (!this.button) {
      this.button = document.createElement('button')
      this.button.setAttribute('type', 'button')
      this.button.setAttribute('data-testid', 'add-to-cart')
      this.button.addEventListener('click', this.handleClick)
      this.innerHTML = ''
      this.appendChild(this.button)
    }

    this.button.disabled = isDisabled || cartState.loading || !variantId
    this.button.setAttribute('aria-busy', String(cartState.loading))
    this.button.textContent = cartState.loading ? 'Adding...' : 'Add to Cart'
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.requestRender()
  }

  private handleClick = async (): Promise<void> => {
    const variantId = this.getAttribute('variant-id')
    if (!variantId) return
    try {
      await this.client.cart.addItem(variantId)
      this.dispatchEvent(
        new CustomEvent('nymbal:cart:item-added', {
          bubbles: true,
          composed: true,
          detail: { variantId },
        }),
      )
    } catch {
      // error is stored in cart state
    }
  }
}
