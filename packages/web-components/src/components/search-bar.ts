import { css, html, nothing } from 'lit'
import type { DenormalisedProduct } from '@nymbalhq/sdk'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-search-bar',
  reactName: 'SearchBar',
  attributes: [
    { name: 'placeholder', prop: 'placeholder', type: 'string' },
    { name: 'debounce-ms', prop: 'debounceMs', type: 'number' },
  ],
  events: [
    { name: 'nymbal:search:selected', prop: 'onSearchSelect', detail: '{ product: unknown }' },
  ],
  parts: ['input', 'results', 'loading', 'result', 'result-name', 'result-price'],
  slots: ['loading'],
  children: false,
}

/** What a search bar shows before any search, and on a server. */
const NO_SEARCH = { query: '', loading: false, results: [] as DenormalisedProduct[] }

function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100)
}

export class NymbalSearchBar extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        position: relative;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='input'] {
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        font-size: var(--nymbal-font-size-base, 1rem);
        width: 100%;
        padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-md, 0.375rem);
        outline: none;
        transition: border-color var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='input']:focus {
        border-color: var(--nymbal-color-accent, #2563eb);
      }
      [part~='results'] {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: var(--nymbal-color-surface, #ffffff);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-top: none;
        border-radius: 0 0 var(--nymbal-radius-md, 0.375rem) var(--nymbal-radius-md, 0.375rem);
        box-shadow: var(--nymbal-shadow-md, 0 4px 6px rgba(0, 0, 0, 0.1));
        z-index: var(--nymbal-z-dropdown, 100);
        max-height: 300px;
        overflow-y: auto;
      }
      [part~='result'] {
        padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
        cursor: pointer;
        transition: background var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='result']:hover,
      [part~='result'][aria-selected='true'] {
        background: var(--nymbal-color-secondary, #f4f4f5);
      }
      [part~='result-name'] {
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='result-price'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='loading'] {
        padding: var(--nymbal-spacing-md, 1rem);
        text-align: center;
        color: var(--nymbal-color-text-muted, #71717a);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
      }
    `,
  ]

  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private selectedIndex = -1

  protected override stores() {
    return [this.client.search]
  }

  protected override render() {
    const state = this.readsStores ? this.client.search.getState() : NO_SEARCH
    const placeholder = this.getAttribute('placeholder') ?? 'Search products...'

    let results: unknown = nothing
    if (state.query) {
      if (state.loading) {
        results = html`<div part="results" data-testid="search-results">
          <div part="loading"><slot name="loading">Searching...</slot></div>
        </div>`
      } else if (state.results.length > 0) {
        results = html`<div part="results" data-testid="search-results">
          ${state.results.map(
            (product, i) => html`
              <div
                part="result"
                class="nymbal-search-result-item"
                data-testid="search-result-${product.slug}"
                data-slug=${product.slug}
                aria-selected=${String(i === this.selectedIndex)}
                @click=${() => this.select(product)}
              >
                <div part="result-name">${product.name}</div>
                ${product.priceMinor !== null
                  ? html`<div part="result-price">
                      ${formatPrice(product.priceMinor, product.currency ?? 'USD')}
                    </div>`
                  : nothing}
              </div>
            `,
          )}
        </div>`
      }
    }

    return html`
      <input
        part="input"
        data-testid="search-input"
        type="search"
        placeholder=${placeholder}
        .value=${state.query}
        autocomplete="off"
        role="combobox"
        aria-expanded=${String(state.results.length > 0)}
        aria-haspopup="listbox"
        @input=${this.handleInput}
        @keydown=${this.handleKeydown}
      />
      ${results}
    `
  }

  private handleInput = (e: Event): void => {
    const query = (e.target as HTMLInputElement).value
    const debounceMs = Number(this.getAttribute('debounce-ms')) || 300
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.selectedIndex = -1
      if (query.trim()) {
        void this.client.search.search(query)
      } else {
        this.client.search.clearSearch()
      }
    }, debounceMs)
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    const { results } = this.client.search.getState()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.selectedIndex = Math.min(this.selectedIndex + 1, results.length - 1)
      this.requestUpdate()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      this.selectedIndex = Math.max(this.selectedIndex - 1, -1)
      this.requestUpdate()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const selected = this.selectedIndex >= 0 ? results[this.selectedIndex] : undefined
      if (selected) {
        this.select(selected)
      } else {
        const query = (e.target as HTMLInputElement).value.trim()
        if (query) {
          window.location.href = `/search?q=${encodeURIComponent(query)}`
        }
      }
    } else if (e.key === 'Escape') {
      this.client.search.clearSearch()
      this.selectedIndex = -1
    }
  }

  private select(product: DenormalisedProduct): void {
    this.dispatchEvent(
      new CustomEvent('nymbal:search:selected', {
        bubbles: true,
        composed: true,
        detail: { product, query: product.name },
      }),
    )
    this.client.search.clearSearch()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }
}
