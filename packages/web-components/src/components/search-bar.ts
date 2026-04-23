import { NymbalElement } from '../base-element.js'
import { injectStyles } from '../styles.js'

const STYLES = `
nymbal-search-bar {
  display: block;
  position: relative;
  font-family: var(--nymbal-font-family);
}
nymbal-search-bar input {
  font-family: var(--nymbal-font-family);
  font-size: var(--nymbal-font-size-base);
  width: 100%;
  padding: var(--nymbal-spacing-sm) var(--nymbal-spacing-md);
  border: 1px solid var(--nymbal-color-border);
  border-radius: var(--nymbal-radius-md);
  outline: none;
  transition: border-color var(--nymbal-transition-fast);
  box-sizing: border-box;
}
nymbal-search-bar input:focus {
  border-color: var(--nymbal-color-accent);
}
nymbal-search-bar .nymbal-search-results {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--nymbal-color-surface);
  border: 1px solid var(--nymbal-color-border);
  border-top: none;
  border-radius: 0 0 var(--nymbal-radius-md) var(--nymbal-radius-md);
  box-shadow: var(--nymbal-shadow-md);
  z-index: var(--nymbal-z-dropdown);
  max-height: 300px;
  overflow-y: auto;
}
nymbal-search-bar .nymbal-search-result-item {
  padding: var(--nymbal-spacing-sm) var(--nymbal-spacing-md);
  cursor: pointer;
  transition: background var(--nymbal-transition-fast);
}
nymbal-search-bar .nymbal-search-result-item:hover,
nymbal-search-bar .nymbal-search-result-item[aria-selected="true"] {
  background: var(--nymbal-color-secondary, #f4f4f5);
}
nymbal-search-bar .nymbal-search-result-name {
  font-weight: var(--nymbal-font-weight-medium);
}
nymbal-search-bar .nymbal-search-result-price {
  font-size: var(--nymbal-font-size-sm);
  color: var(--nymbal-color-text-muted);
}
nymbal-search-bar .nymbal-search-loading {
  padding: var(--nymbal-spacing-md);
  text-align: center;
  color: var(--nymbal-color-text-muted);
  font-size: var(--nymbal-font-size-sm);
}
`

export class NymbalSearchBar extends NymbalElement {
  static get observedAttributes(): string[] {
    return ['placeholder', 'debounce-ms']
  }

  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private selectedIndex = -1

  protected setup(): void {
    injectStyles('nymbal-search-bar', STYLES)
    this.subscribeToStore(this.client.search)
  }

  protected render(): void {
    const state = this.client.search.getState()
    const placeholder = this.getAttribute('placeholder') ?? 'Search products...'

    let resultsHtml = ''
    if (state.query) {
      if (state.loading) {
        resultsHtml = `<div class="nymbal-search-results" data-testid="search-results"><div class="nymbal-search-loading">Searching...</div></div>`
      } else if (state.results.length > 0) {
        resultsHtml = `<div class="nymbal-search-results" data-testid="search-results">
          ${state.results.map((product, i) => `
            <div class="nymbal-search-result-item" data-testid="search-result-${product.slug}" data-slug="${product.slug}" aria-selected="${i === this.selectedIndex}">
              <div class="nymbal-search-result-name">${this.esc(product.name)}</div>
              ${product.priceMinor !== null ? `<div class="nymbal-search-result-price">${this.formatPrice(product.priceMinor, product.currency ?? 'USD')}</div>` : ''}
            </div>
          `).join('')}
        </div>`
      }
    }

    this.innerHTML = `
      <input data-testid="search-input" type="search" placeholder="${placeholder}" value="${this.esc(state.query)}" autocomplete="off" role="combobox" aria-expanded="${state.results.length > 0}" aria-haspopup="listbox">
      ${resultsHtml}
    `

    const input = this.querySelector('input')!
    input.addEventListener('input', () => {
      const query = input.value
      const debounceMs = Number(this.getAttribute('debounce-ms')) || 300
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        this.selectedIndex = -1
        if (query.trim()) {
          this.client.search.search(query)
        } else {
          this.client.search.clearSearch()
        }
      }, debounceMs)
    })

    input.addEventListener('keydown', (e) => {
      const results = state.results
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.selectedIndex = Math.min(this.selectedIndex + 1, results.length - 1)
        this.render()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        this.selectedIndex = Math.max(this.selectedIndex - 1, -1)
        this.render()
      } else if (e.key === 'Enter' && this.selectedIndex >= 0) {
        e.preventDefault()
        const selected = results[this.selectedIndex]
        if (selected) {
          this.dispatchEvent(
            new CustomEvent('nymbal:search:selected', {
              bubbles: true,
              composed: true,
              detail: { product: selected },
            }),
          )
        }
      } else if (e.key === 'Escape') {
        this.client.search.clearSearch()
        this.selectedIndex = -1
      }
    })
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.requestRender()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private esc(str: string): string {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  private formatPrice(minor: number, currency: string): string {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100)
  }
}
