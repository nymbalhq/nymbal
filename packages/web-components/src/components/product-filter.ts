import type { Facet } from '@nymbalhq/types'
import { NymbalElement } from '../base-element.js'
import { injectStyles } from '../styles.js'

const STYLES = `
nymbal-product-filter {
  display: block;
  font-family: var(--nymbal-font-family);
}
nymbal-product-filter .nymbal-filter-group {
  margin-bottom: var(--nymbal-spacing-lg);
}
nymbal-product-filter .nymbal-filter-label {
  display: block;
  font-size: var(--nymbal-font-size-sm);
  font-weight: var(--nymbal-font-weight-bold);
  margin-bottom: var(--nymbal-spacing-sm);
  color: var(--nymbal-color-text);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
nymbal-product-filter .nymbal-filter-option {
  display: flex;
  align-items: center;
  gap: var(--nymbal-spacing-sm);
  padding: var(--nymbal-spacing-xs) 0;
  cursor: pointer;
  font-size: var(--nymbal-font-size-sm);
  color: var(--nymbal-color-text);
}
nymbal-product-filter .nymbal-filter-option input[type="checkbox"] {
  accent-color: var(--nymbal-color-primary);
}
nymbal-product-filter .nymbal-filter-count {
  color: var(--nymbal-color-text-muted);
  font-size: var(--nymbal-font-size-xs);
}
`


/**
 * The facet filter. By default it reads the `facets` attribute and filters the product list. With `source="search"`
 * it renders the search's own facets and narrows the search to one category: choosing an option selects it, choosing
 * the selected option again clears it.
 */
export class NymbalProductFilter extends NymbalElement {
  static get observedAttributes(): string[] {
    return ['facets', 'source']
  }

  protected setup(): void {
    injectStyles('nymbal-product-filter', STYLES)
    // Both: a wrapper may set `source` after the element has connected.
    this.subscribeToStore(this.client.productList)
    this.subscribeToStore(this.client.search)
  }

  protected render(): void {
    if (this.isSearch()) {
      this.renderSearch()
      return
    }
    const state = this.client.productList.getState()
    const facets = this.getFacets()

    if (facets.length === 0) {
      this.innerHTML = ''
      return
    }

    this.innerHTML = facets.map((facet) => {
      const activeFilter = state.filters[facet.field]
      const activeValues = Array.isArray(activeFilter)
        ? activeFilter
        : (activeFilter ? [activeFilter] : [])

      return `
        <div class="nymbal-filter-group" data-testid="filter-group-${facet.field}">
          <span class="nymbal-filter-label">${this.esc(facet.label)}</span>
          ${facet.values.map((v) => {
            const checked = activeValues.includes(v.value)
            return `
              <label class="nymbal-filter-option" data-testid="filter-option-${v.value}">
                <input type="checkbox" data-filter-name="${facet.field}" data-filter-value="${v.value}" ${checked ? 'checked' : ''}>
                <span>${this.esc(v.label ?? v.value)}</span>
                ${v.count !== undefined ? `<span class="nymbal-filter-count">(${v.count})</span>` : ''}
              </label>
            `
          }).join('')}
        </div>
      `
    }).join('')

    this.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        const el = input as HTMLInputElement
        const name = el.dataset['filterName']!
        const value = el.dataset['filterValue']!
        if (el.checked) {
          const current = state.filters[name]
          const values = Array.isArray(current) ? [...current, value] : (current ? [current, value] : value)
          this.client.productList.applyFilter(name, values)
        } else {
          const current = state.filters[name]
          if (Array.isArray(current)) {
            const remaining = current.filter((v) => v !== value)
            if (remaining.length > 0) {
              this.client.productList.applyFilter(name, remaining)
            } else {
              this.client.productList.removeFilter(name)
            }
          } else {
            this.client.productList.removeFilter(name)
          }
        }
        this.dispatchEvent(
          new CustomEvent('nymbal:filter:changed', { bubbles: true, composed: true, detail: { name, value } }),
        )
      })
    })
  }

  private renderSearch(): void {
    const { facets, category } = this.client.search.getState()
    const shown = facets.filter((f) => f.field === 'category')
    this.innerHTML = shown
      .map(
        (facet) => `
        <div class="nymbal-filter-group" data-testid="filter-group-${this.esc(facet.field)}">
          <span class="nymbal-filter-label">${this.esc(facet.label)}</span>
          ${facet.values
            .map(
              (v) => `
              <label class="nymbal-filter-option" data-testid="filter-option-${this.esc(v.value)}">
                <input type="checkbox" data-filter-value="${this.esc(v.value)}" ${v.value === category ? 'checked' : ''}>
                <span>${this.esc(v.label ?? v.value)}</span>
                ${v.count !== undefined ? `<span class="nymbal-filter-count">(${v.count})</span>` : ''}
              </label>
            `,
            )
            .join('')}
        </div>
      `,
      )
      .join('')

    this.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        const value = input.dataset['filterValue']!
        void this.client.search.setCategory(input.checked ? value : null)
        this.dispatchEvent(
          new CustomEvent('nymbal:filter:changed', {
            bubbles: true,
            composed: true,
            detail: { name: 'category', value: input.checked ? value : '' },
          }),
        )
      })
    })
  }

  private isSearch(): boolean {
    return this.getAttribute('source') === 'search'
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.requestRender()
  }

  private getFacets(): Facet[] {
    const attr = this.getAttribute('facets')
    if (!attr) return []
    try {
      return JSON.parse(attr) as Facet[]
    } catch (err) {
      console.error('[nymbal-product-filter] failed to parse facets attribute', err)
      return []
    }
  }

  private esc(str: string): string {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }
}
