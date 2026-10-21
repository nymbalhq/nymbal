import { css, html, nothing } from 'lit'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'
import { formatPrice } from '../format.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-product-card',
  reactName: 'ProductCard',
  attributes: [{ name: 'product', prop: 'product', type: 'json' }],
  events: [],
  parts: ['card', 'media', 'image', 'body', 'name', 'price'],
  slots: [],
  children: false,
}

/** The fields a card reads; a search result or a listing product carries them. */
interface CardProduct {
  slug: string
  name: string
  priceMinor?: number | null
  priceRange?: { minMinor: number; maxMinor: number } | null
  currency?: string | null
  media?: Array<{ url?: string; alt?: string }>
}

function parse(raw: string | undefined): CardProduct | null {
  if (raw === undefined || raw === '') return null
  try {
    const value = JSON.parse(raw) as Partial<CardProduct> | null
    return value !== null && typeof value.slug === 'string' ? (value as CardProduct) : null
  } catch {
    console.warn('[nymbal-product-card] the product attribute is not JSON', raw)
    return null
  }
}

function priceOf(p: CardProduct): string | null {
  const currency = p.currency ?? 'GBP'
  if (p.priceMinor != null) return formatPrice(p.priceMinor, currency)
  if (p.priceRange != null) {
    const { minMinor, maxMinor } = p.priceRange
    return minMinor === maxMinor
      ? formatPrice(minMinor, currency)
      : `${formatPrice(minMinor, currency)} – ${formatPrice(maxMinor, currency)}`
  }
  return null
}

/** One product as a link to its page: image, name and price. */
export class NymbalProductCard extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='card'] {
        display: flex;
        flex-direction: column;
        height: 100%;
        color: var(--nymbal-color-text, #18181b);
        text-decoration: none;
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-lg, 0.75rem);
        overflow: hidden;
        background: var(--nymbal-color-surface, #ffffff);
        transition: box-shadow var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='card']:hover {
        box-shadow: var(--nymbal-shadow-md, 0 4px 6px rgba(0, 0, 0, 0.07));
      }
      [part~='card']:focus-visible {
        outline: 2px solid var(--nymbal-color-accent, #2563eb);
        outline-offset: 2px;
      }
      [part~='media'] {
        aspect-ratio: 1 / 1;
        background: #f4f4f5;
      }
      [part~='image'] {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      [part~='body'] {
        display: flex;
        flex-direction: column;
        gap: var(--nymbal-spacing-xs, 0.25rem);
        padding: var(--nymbal-spacing-md, 1rem);
      }
      [part~='name'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='price'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
    `,
  ]

  declare product: string | undefined

  protected override render() {
    const p = parse(this.product)
    if (p === null) return nothing
    const image = p.media?.find((m) => typeof m.url === 'string' && m.url !== '')
    const price = priceOf(p)
    return html`
      <a
        part="card"
        href="/product/${encodeURIComponent(p.slug)}"
        data-testid="product-card-${p.slug}"
      >
        <div part="media">
          ${image
            ? html`<img
                part="image"
                src=${image.url!}
                alt=${image.alt ?? p.name}
                loading="lazy"
                width="600"
                height="600"
              />`
            : nothing}
        </div>
        <div part="body">
          <span part="name">${p.name}</span>
          ${price === null ? nothing : html`<span part="price">${price}</span>`}
        </div>
      </a>
    `
  }
}
