import { css, html } from 'lit'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-mini-cart',
  reactName: 'MiniCart',
  // The cart's item count a server read, shown until the cart store settles.
  attributes: [{ name: 'count', prop: 'count', type: 'number' }],
  events: [{ name: 'nymbal:mini-cart:clicked', prop: 'onClick', detail: 'void' }],
  parts: ['button', 'icon', 'badge'],
  slots: ['icon'],
  children: false,
}

export class NymbalMiniCart extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)

  static override styles = [
    baseStyles,
    css`
      :host {
        display: inline-block;
        position: relative;
      }
      [part~='button'] {
        background: none;
        border: none;
        cursor: pointer;
        position: relative;
        padding: var(--nymbal-spacing-sm, 0.5rem);
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='icon'] {
        display: block;
        width: 24px;
        height: 24px;
      }
      [part~='badge'] {
        position: absolute;
        top: 0;
        right: 0;
        background: var(--nymbal-color-accent, #2563eb);
        color: var(--nymbal-color-text-inverse, #ffffff);
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        min-width: 18px;
        height: 18px;
        border-radius: var(--nymbal-radius-full, 9999px);
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      [part~='badge']:empty {
        display: none;
      }
    `,
  ]

  declare count: number | undefined

  protected override stores() {
    return [this.client.cart]
  }

  protected override storeSettled(): void {
    this.count = undefined
  }

  private itemCount(): number {
    if (typeof this.count === 'number' && Number.isFinite(this.count)) return this.count
    return this.readsStores ? this.client.cart.getState().itemCount : 0
  }

  protected override render() {
    const itemCount = this.itemCount()
    return html`<button
      type="button"
      part="button"
      data-testid="mini-cart"
      aria-label="Cart (${itemCount} items)"
      @click=${this.handleClick}
    >
      <slot name="icon"
        ><svg
          part="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="9" cy="21" r="1" />
          <circle cx="20" cy="21" r="1" />
          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" /></svg
      ></slot>
      <span part="badge" class="nymbal-mini-cart-badge" data-testid="mini-cart-badge"
        >${itemCount > 0 ? itemCount : ''}</span
      >
    </button>`
  }

  private handleClick = (): void => {
    this.dispatchEvent(
      new CustomEvent('nymbal:mini-cart:clicked', { bubbles: true, composed: true }),
    )
  }
}
