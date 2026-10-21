import { NymbalElement } from '../base-element.js'
import { injectStyles } from '../styles.js'

const STYLES = `
nymbal-quantity-selector {
  display: inline-flex;
  align-items: center;
  font-family: var(--nymbal-font-family);
}
nymbal-quantity-selector button {
  font-family: var(--nymbal-font-family);
  font-size: var(--nymbal-font-size-base);
  background: var(--nymbal-color-surface);
  color: var(--nymbal-color-text);
  border: 1px solid var(--nymbal-color-border);
  width: 36px;
  height: 36px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--nymbal-transition-fast);
}
nymbal-quantity-selector button:hover:not(:disabled) {
  background: var(--nymbal-color-secondary, #f4f4f5);
}
nymbal-quantity-selector button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
nymbal-quantity-selector button:first-child {
  border-radius: var(--nymbal-radius-md) 0 0 var(--nymbal-radius-md);
}
nymbal-quantity-selector button:last-child {
  border-radius: 0 var(--nymbal-radius-md) var(--nymbal-radius-md) 0;
}
nymbal-quantity-selector input {
  font-family: var(--nymbal-font-family);
  font-size: var(--nymbal-font-size-base);
  width: 48px;
  height: 36px;
  text-align: center;
  border: 1px solid var(--nymbal-color-border);
  border-left: none;
  border-right: none;
  -moz-appearance: textfield;
}
nymbal-quantity-selector input::-webkit-outer-spin-button,
nymbal-quantity-selector input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
`

/**
 * A quantity as a whole number of units in `min`-`max`: a number is truncated toward zero and clamped, anything else is
 * `min`. Add-to-cart takes only integers, so the selector shows and emits the same integer.
 */
function wholeQuantity(raw: string | null, min: number, max: number): number {
  const n = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
  if (Number.isNaN(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export class NymbalQuantitySelector extends NymbalElement {
  static get observedAttributes(): string[] {
    return ['value', 'min', 'max']
  }

  private _value = 1

  protected setup(): void {
    injectStyles('nymbal-quantity-selector', STYLES)
    this._value = wholeQuantity(this.getAttribute('value'), ...this.bounds())
  }

  private bounds(): [number, number] {
    return [Number(this.getAttribute('min')) || 1, Number(this.getAttribute('max')) || 99]
  }

  protected render(): void {
    const [min, max] = this.bounds()

    this.innerHTML = `
      <button data-testid="qty-decrement" aria-label="Decrease quantity" ${this._value <= min ? 'disabled' : ''}>&#8722;</button>
      <input data-testid="qty-input" type="number" value="${this._value}" min="${min}" max="${max}" aria-label="Quantity">
      <button data-testid="qty-increment" aria-label="Increase quantity" ${this._value >= max ? 'disabled' : ''}>&#43;</button>
    `

    this.querySelector('[data-testid="qty-decrement"]')?.addEventListener('click', () => {
      if (this._value > min) {
        this._value--
        this.emitChange()
        this.render()
      }
    })

    this.querySelector('[data-testid="qty-increment"]')?.addEventListener('click', () => {
      if (this._value < max) {
        this._value++
        this.emitChange()
        this.render()
      }
    })

    const input = this.querySelector('input')
    input?.addEventListener('change', () => {
      this._value = wholeQuantity(input.value, min, max)
      this.emitChange()
      this.render()
    })
  }

  attributeChangedCallback(name: string): void {
    if (name === 'value') {
      this._value = wholeQuantity(this.getAttribute('value'), ...this.bounds())
    }
    if (this.isConnected) this.requestRender()
  }

  private emitChange(): void {
    this.dispatchEvent(
      new CustomEvent('nymbal:quantity:changed', {
        bubbles: true,
        composed: true,
        detail: { value: this._value },
      }),
    )
  }
}
