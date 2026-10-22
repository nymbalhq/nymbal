import { css, html, nothing } from 'lit'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'
import { formatPrice } from '../format.js'
import { navigateOnClick } from '../navigate.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-product-card',
  reactName: 'ProductCard',
  // `eager`: the card is in a grid's first row, so its image is the page's likely LCP and is fetched at once.
  attributes: [
    { name: 'product', prop: 'product', type: 'json' },
    { name: 'eager', prop: 'eager', type: 'boolean' },
  ],
  events: [],
  parts: ['card', 'media', 'image', 'body', 'name', 'price'],
  slots: [],
  children: false,
}

/** The fields a card reads; a search result or a listing product carries them. */
export interface CardProduct {
  slug: string
  name: string
  priceMinor?: number | null
  priceRange?: { minMinor: number; maxMinor: number } | null
  currency?: string | null
  imageUrl?: string | null
  media?: Array<{ url?: string; alt?: string }>
}

/** The product's own image, else a placeholder seeded by its slug so a card without media keeps its shape. */
function imageOf(p: CardProduct): { url: string; alt: string } {
  if (typeof p.imageUrl === 'string' && p.imageUrl !== '') return { url: p.imageUrl, alt: p.name }
  const media = p.media?.find((m) => typeof m.url === 'string' && m.url !== '')
  if (media !== undefined) return { url: media.url!, alt: media.alt ?? p.name }
  return { url: `https://picsum.photos/seed/${encodeURIComponent(p.slug)}/600/600`, alt: p.name }
}

/**
 * A product as a card reads it, and nothing else: a listing's products carry their variants, descriptions and
 * categories, which a page of cards would otherwise put in its HTML once per card.
 */
export function cardProductOf(p: Omit<CardProduct, 'media'> & { media?: unknown }): CardProduct {
  const list = Array.isArray(p.media) ? (p.media as NonNullable<CardProduct['media']>) : []
  const media = list.find((m) => typeof m.url === 'string' && m.url !== '')
  const image =
    typeof p.imageUrl === 'string' && p.imageUrl !== ''
      ? { imageUrl: p.imageUrl }
      : media === undefined
        ? {}
        : { media: [{ url: media.url!, ...(media.alt !== undefined && { alt: media.alt }) }] }
  return {
    slug: p.slug,
    name: p.name,
    priceMinor: p.priceMinor ?? null,
    priceRange: p.priceRange ?? null,
    currency: p.currency ?? null,
    ...image,
  }
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

/** The "from" price, which the price sorts order by: the cheapest variant's when the product has a range. */
function priceOf(p: CardProduct): string | null {
  const from = p.priceRange?.minMinor ?? p.priceMinor
  return from == null ? null : formatPrice(from, p.currency ?? 'GBP')
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
  declare eager: boolean | undefined

  protected override render() {
    const p = parse(this.product)
    if (p === null) return nothing
    const image = imageOf(p)
    const price = priceOf(p)
    return html`
      <a
        part="card"
        href="/product/${encodeURIComponent(p.slug)}"
        data-testid="product-card-${p.slug}"
        @click=${navigateOnClick}
      >
        <div part="media">
          <img
            part="image"
            src=${image.url}
            alt=${image.alt}
            loading=${this.eager === true ? 'eager' : 'lazy'}
            fetchpriority=${this.eager === true ? 'high' : nothing}
            width="600"
            height="600"
          />
        </div>
        <div part="body">
          <span part="name">${p.name}</span>
          ${price === null ? nothing : html`<span part="price">${price}</span>`}
        </div>
      </a>
    `
  }
}
