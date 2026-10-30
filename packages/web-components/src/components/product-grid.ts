import '@nymbalhq/sdk/ns/product-list'
import { css, html, nothing } from 'lit'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'
import { buttonStyles } from '../view-styles.js'
import { cardProductOf, NymbalProductCard } from './product-card.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-product-grid',
  reactName: 'ProductGrid',
  // `products`: the cards a server read. `source="product-list"`: the grid is a listing's, and follows the product-list
  // store once it settles (a sort, a filter, load more); without it the grid is static. `has-more`: the server's page
  // has a next one, so its render shows load more exactly when the store will. `lazy`: the grid sits below the fold
  // (a product page's related grid), so no card is eager and its images never outrank the page's LCP image.
  attributes: [
    { name: 'products', prop: 'products', type: 'json' },
    { name: 'source', prop: 'source', type: 'string' },
    { name: 'has-more', prop: 'hasMore', type: 'boolean' },
    { name: 'lazy', prop: 'lazy', type: 'boolean' },
  ],
  events: [],
  parts: ['grid', 'empty', 'count', 'load-more'],
  slots: ['empty'],
  children: false,
}

/** The first row of a wide grid: those cards' images are the page's likely LCP. */
const EAGER_CARDS = 4

interface Shown {
  products: unknown[]
  hasMore: boolean
  loading: boolean
}

/** A grid of `nymbal-product-card`s, a listing's (following the product-list store) or a static one. */
export class NymbalProductGrid extends NymbalElement {
  static override schema = SCHEMA
  static uses = [NymbalProductCard]
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    buttonStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='count'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='grid'] {
        display: grid;
        gap: var(--nymbal-spacing-md, 1rem);
        grid-template-columns: 1fr;
      }
      @media (min-width: 641px) {
        [part~='grid'] {
          grid-template-columns: repeat(2, 1fr);
          gap: var(--nymbal-spacing-lg, 1.5rem);
        }
      }
      @media (min-width: 1025px) {
        [part~='grid'] {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      [part~='empty'] {
        padding: var(--nymbal-spacing-xl, 2rem) 0;
        text-align: center;
        color: var(--nymbal-color-text-muted, #71717a);
      }
      .more {
        display: flex;
        justify-content: center;
        margin-top: var(--nymbal-spacing-xl, 2rem);
      }
    `,
  ]

  declare products: unknown
  declare source: string | undefined
  declare hasMore: boolean | undefined
  declare lazy: boolean | undefined

  private get listing(): boolean {
    return this.source === 'product-list'
  }

  protected override stores() {
    return this.listing ? [this.client.productList] : []
  }

  protected override storeSettled(): void {
    // A store already settled when this grid connected may be loading this page's listing now; its last answer was
    // another listing's (a soft navigation), so the server's cards stand until this load settles.
    if (this.client.productList.getState().loading) return
    this.products = undefined
    this.hasMore = undefined
  }

  /** The server's cards while they stand, else (a listing with a client) the product-list store's. */
  private shown(): Shown {
    const given = parsedJson<unknown[]>(this, 'products', this.products)
    if (given === undefined && this.listing && this.readsStores) {
      const state = this.client.productList.getState()
      return {
        products: state.products,
        hasMore: state.pagination.hasMore,
        loading: state.loading,
      }
    }
    return {
      products: Array.isArray(given) ? given : [],
      hasMore: this.hasMore === true,
      loading: false,
    }
  }

  protected override render() {
    const { products, hasMore, loading } = this.shown()
    const count = products.length
    return html`
      ${this.listing
        ? html`<p part="count">${count} product${count === 1 ? '' : 's'}</p>`
        : nothing}
      ${count === 0
        ? loading
          ? nothing
          : html`<div part="empty"><slot name="empty">No products found.</slot></div>`
        : html`
            <div part="grid">
              ${products.map(
                (p, i) =>
                  html`<nymbal-product-card
                    product=${JSON.stringify(
                      cardProductOf(p as Parameters<typeof cardProductOf>[0]),
                    )}
                    ?eager=${this.lazy !== true && i < EAGER_CARDS}
                  ></nymbal-product-card>`,
              )}
            </div>
          `}
      ${this.listing && hasMore
        ? html`
            <div class="more">
              <button
                type="button"
                part="load-more"
                class="btn btn-secondary"
                data-testid="load-more"
                ?disabled=${loading}
                @click=${() => void this.client.productList.loadMore()}
              >
                Load more
              </button>
            </div>
          `
        : nothing}
    `
  }
}
