import { css, html, nothing } from 'lit'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { formatPrice } from '../format.js'
import { NymbalVariantElement } from '../selected-variant.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-product-price',
  reactName: 'ProductPrice',
  // The product's first variant's price as a server read it, and the product whose store updates it may follow.
  attributes: [
    { name: 'product-id', prop: 'productId', type: 'string' },
    { name: 'price-minor', prop: 'priceMinor', type: 'number' },
    { name: 'currency', prop: 'currency', type: 'string' },
    { name: 'compare-at-minor', prop: 'compareAtMinor', type: 'number' },
  ],
  events: [],
  parts: ['price', 'compare-at'],
  slots: [],
  children: false,
}

/** A product page's price: the selected variant's once the product store holds this product. */
export class NymbalProductPrice extends NymbalVariantElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='price'] {
        font-size: 1.5rem;
        font-weight: var(--nymbal-font-weight-bold, 700);
        color: var(--nymbal-color-primary, #18181b);
      }
      [part~='compare-at'] {
        margin-right: var(--nymbal-spacing-sm, 0.5rem);
        font-size: 1.5rem;
        font-weight: var(--nymbal-font-weight-normal, 400);
        color: var(--nymbal-color-text-muted, #71717a);
        text-decoration: line-through;
      }
    `,
  ]

  declare priceMinor: number | undefined
  declare currency: string | undefined
  declare compareAtMinor: number | undefined

  protected override render() {
    const store = this.selected()
    const currency = store?.product.currency ?? this.currency ?? 'GBP'
    const price =
      store === null ? this.priceMinor : (store.variant?.priceMinor ?? store.product.priceMinor)
    // A variant carries no compare-at price, so one the server was given stands for the first variant only.
    const compareAt = store === null ? this.compareAtMinor : undefined
    if (price === undefined || price === null || Number.isNaN(price)) return nothing
    return html`
      ${compareAt !== undefined && compareAt > price
        ? html`<s part="compare-at">${formatPrice(compareAt, currency)}</s>`
        : nothing}
      <span part="price" data-testid="product-price">${formatPrice(price, currency)}</span>
    `
  }
}
