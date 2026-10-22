import { css, html, nothing, type PropertyValues } from 'lit'
import type { Facet } from '@nymbalhq/types'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
  type Subscribable,
} from '../base-element.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-product-filter',
  reactName: 'ProductFilter',
  attributes: [
    { name: 'facets', prop: 'facets', type: 'json' },
    { name: 'source', prop: 'source', type: 'string' },
  ],
  events: [
    {
      name: 'nymbal:filter:changed',
      prop: 'onFilterChange',
      detail: '{ name: string; value: string }',
    },
  ],
  parts: ['group', 'label', 'option', 'checkbox', 'option-label', 'count'],
  slots: [],
  children: false,
}

/**
 * The facet filter. By default it reads the `facets` attribute and filters the product list. With `source="search"`
 * it renders the search's own facets and narrows the search to one category: choosing an option selects it, choosing
 * the selected option again clears it. The host carries `empty` while it renders no facet, so a page can lay out
 * around it (its light DOM is always empty).
 */
export class NymbalProductFilter extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='group'] {
        margin-bottom: var(--nymbal-spacing-lg, 1.5rem);
      }
      [part~='label'] {
        display: block;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        margin-bottom: var(--nymbal-spacing-sm, 0.5rem);
        color: var(--nymbal-color-text, #18181b);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      [part~='option'] {
        display: flex;
        align-items: center;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        padding: var(--nymbal-spacing-xs, 0.25rem) 0;
        cursor: pointer;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='checkbox'] {
        margin: 0;
        accent-color: var(--nymbal-color-primary, #18181b);
      }
      [part~='count'] {
        color: var(--nymbal-color-text-muted, #71717a);
        font-size: var(--nymbal-font-size-xs, 0.75rem);
      }
    `,
  ]

  declare facets: unknown

  /** Both: a wrapper may set `source` after the element has connected. */
  protected override stores() {
    return [this.client.productList, this.client.search]
  }

  /** With `source="search"` the `facets` a server read stand until the search settles; a listing's always show. */
  protected override storeSettled(store: Subscribable): void {
    if (store === this.client.search && this.getAttribute('source') === 'search') {
      this.facets = undefined
    }
  }

  /** The facets this render shows, and whether each value is checked. */
  private shown(): { facets: Facet[]; checked: (field: string, value: string) => boolean } {
    if (this.getAttribute('source') === 'search') {
      const given = parsedJson<Facet[]>(this, 'facets', this.facets)
      const { facets, category } =
        given === undefined && this.readsStores
          ? this.client.search.getState()
          : { facets: given ?? [], category: null }
      return {
        facets: facets.filter((f) => f.field === 'category'),
        checked: (_field, value) => value === category,
      }
    }
    const filters = this.readsStores ? this.client.productList.getState().filters : {}
    return {
      facets: this.facetsAttribute(),
      checked: (field, value) => {
        const active = filters[field]
        return Array.isArray(active) ? active.includes(value) : active === value
      },
    }
  }

  private _shown: ReturnType<NymbalProductFilter['shown']> = { facets: [], checked: () => false }

  protected override willUpdate(_changed: PropertyValues): void {
    this._shown = this.shown()
    this.toggleAttribute('empty', this._shown.facets.length === 0)
  }

  protected override render() {
    const { facets, checked } = this._shown
    return facets.map(
      (facet) => html`
        <div part="group" data-testid="filter-group-${facet.field}">
          <span part="label">${facet.label}</span>
          ${facet.values.map(
            (v) => html`
              <label part="option" data-testid="filter-option-${v.value}">
                <input
                  part="checkbox"
                  type="checkbox"
                  data-filter-name=${facet.field}
                  data-filter-value=${v.value}
                  .checked=${checked(facet.field, v.value)}
                  @change=${this.handleChange}
                />
                <span part="option-label">${v.label ?? v.value}</span>
                ${v.count !== undefined ? html`<span part="count" class="nymbal-filter-count">(${v.count})</span>` : nothing}
              </label>
            `,
          )}
        </div>
      `,
    )
  }

  private handleChange = (e: Event): void => {
    const input = e.target as HTMLInputElement
    const value = input.dataset['filterValue']!
    if (this.getAttribute('source') === 'search') {
      void this.client.search.setCategory(input.checked ? value : null)
      this.emit('category', input.checked ? value : '')
      return
    }
    const name = input.dataset['filterName']!
    const current = this.client.productList.getState().filters[name]
    if (input.checked) {
      const values = Array.isArray(current)
        ? [...current, value]
        : current
          ? [current, value]
          : value
      void this.client.productList.applyFilter(name, values)
    } else if (Array.isArray(current)) {
      const remaining = current.filter((v) => v !== value)
      if (remaining.length > 0) {
        void this.client.productList.applyFilter(name, remaining)
      } else {
        void this.client.productList.removeFilter(name)
      }
    } else {
      void this.client.productList.removeFilter(name)
    }
    this.emit(name, value)
  }

  private emit(name: string, value: string): void {
    this.dispatchEvent(
      new CustomEvent('nymbal:filter:changed', {
        bubbles: true,
        composed: true,
        detail: { name, value },
      }),
    )
  }

  private facetsAttribute(): Facet[] {
    return parsedJson<Facet[]>(this, 'facets', this.facets) ?? []
  }
}
