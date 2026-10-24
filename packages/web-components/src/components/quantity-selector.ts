import { css, html, type PropertyValues } from 'lit'
import { live } from 'lit/directives/live.js'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'

/**
 * A quantity as a whole number of units in `min`-`max`: a number is truncated toward zero and clamped, anything else is
 * `min`. Add-to-cart takes only integers, so the selector shows and emits the same integer.
 */
function wholeQuantity(raw: string | null, min: number, max: number): number {
  const n = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
  if (Number.isNaN(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

const SCHEMA: ElementSchema = {
  tag: 'nymbal-quantity-selector',
  reactName: 'QuantitySelector',
  attributes: [
    { name: 'value', prop: 'value', type: 'number' },
    { name: 'min', prop: 'min', type: 'number' },
    { name: 'max', prop: 'max', type: 'number' },
  ],
  events: [
    { name: 'nymbal:quantity:changed', prop: 'onQuantityChange', detail: '{ value: number }' },
  ],
  parts: ['decrement', 'input', 'increment'],
  slots: [],
  children: false,
}

export class NymbalQuantitySelector extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)

  static override styles = [
    baseStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='decrement'],
      [part~='increment'] {
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        font-size: var(--nymbal-font-size-base, 1rem);
        background: var(--nymbal-color-surface, #ffffff);
        color: var(--nymbal-color-text, #18181b);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        width: 36px;
        height: 36px;
        padding: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='decrement']:hover:not(:disabled),
      [part~='increment']:hover:not(:disabled) {
        background: var(--nymbal-color-secondary, #f4f4f5);
      }
      [part~='decrement']:disabled,
      [part~='increment']:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      [part~='decrement'] {
        border-radius: var(--nymbal-radius-md, 0.375rem) 0 0 var(--nymbal-radius-md, 0.375rem);
      }
      [part~='increment'] {
        border-radius: 0 var(--nymbal-radius-md, 0.375rem) var(--nymbal-radius-md, 0.375rem) 0;
      }
      [part~='input'] {
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        font-size: var(--nymbal-font-size-base, 1rem);
        width: 48px;
        height: 36px;
        padding: 0;
        margin: 0;
        text-align: center;
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-left: none;
        border-right: none;
        -moz-appearance: textfield;
      }
      [part~='input']::-webkit-outer-spin-button,
      [part~='input']::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
    `,
  ]

  private _value = 1

  private bounds(): [number, number] {
    return [Number(this.getAttribute('min')) || 1, Number(this.getAttribute('max')) || 99]
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (!this.hasUpdated || changed.has('value')) {
      this._value = wholeQuantity(this.getAttribute('value'), ...this.bounds())
    }
  }

  // Setting `value` resets the quantity even to the value the attribute already holds (a page resetting to 1 after the
  // shopper stepped up), which Lit's own change check would skip.
  override attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value)
    if (name === 'value' && old === value && this.hasUpdated) {
      this._value = wholeQuantity(value, ...this.bounds())
      this.requestUpdate()
    }
  }

  protected override render() {
    const [min, max] = this.bounds()
    return html`
      <button
        type="button"
        part="decrement"
        data-testid="qty-decrement"
        aria-label="Decrease quantity"
        ?disabled=${this._value <= min}
        @click=${() => this.step(-1)}
      >
        &#8722;
      </button>
      <input
        part="input"
        data-testid="qty-input"
        type="number"
        .value=${live(String(this._value))}
        min=${min}
        max=${max}
        aria-label="Quantity"
        @change=${this.handleChange}
      />
      <button
        type="button"
        part="increment"
        data-testid="qty-increment"
        aria-label="Increase quantity"
        ?disabled=${this._value >= max}
        @click=${() => this.step(1)}
      >
        &#43;
      </button>
    `
  }

  private step(by: number): void {
    const [min, max] = this.bounds()
    const next = this._value + by
    if (next < min || next > max) return
    this._value = next
    this.emitChange()
    this.requestUpdate()
  }

  private handleChange = (e: Event): void => {
    const [min, max] = this.bounds()
    this._value = wholeQuantity((e.target as HTMLInputElement).value, min, max)
    this.emitChange()
    this.requestUpdate()
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
