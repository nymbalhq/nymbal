import { css, html, nothing } from 'lit'
import { STOCK_LABELS, stockLevel } from '@nymbalhq/types'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalVariantElement } from '../selected-variant.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-stock-badge',
  reactName: 'StockBadge',
  // The product's first variant's stock as a server read it, and the product whose store updates it may follow.
  attributes: [
    { name: 'product-id', prop: 'productId', type: 'string' },
    { name: 'stock', prop: 'stock', type: 'number' },
  ],
  events: [],
  parts: ['badge', 'label'],
  slots: [],
  children: false,
}

/** A product page's stock level (`@nymbalhq/types`' rule): the selected variant's once the store holds this product. */
export class NymbalStockBadge extends NymbalVariantElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='badge'] {
        display: inline-flex;
        align-items: center;
        gap: var(--nymbal-spacing-xs, 0.25rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='badge'][data-level='in'] {
        color: var(--nymbal-color-success, #16a34a);
      }
      [part~='badge'][data-level='low'] {
        color: var(--nymbal-color-warning, #d97706);
      }
      [part~='badge'][data-level='out'] {
        color: var(--nymbal-color-error, #dc2626);
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: var(--nymbal-radius-full, 9999px);
        background-color: currentColor;
      }
    `,
  ]

  declare stock: number | undefined

  protected override render() {
    const store = this.selected()
    // A product with no variants has nothing to sell, so it reads as out of stock.
    const stock = store === null ? this.stock : (store.variant?.stock ?? 0)
    if (stock === undefined || Number.isNaN(stock)) return nothing
    const level = stockLevel(stock)
    return html`
      <span part="badge" data-testid="stock-badge" data-level=${level}>
        <span class="dot" aria-hidden="true"></span>
        <span part="label">${STOCK_LABELS[level]}</span>
      </span>
    `
  }
}
