import { DEFAULT_PRODUCT_SORT, PRODUCT_SORT_LABELS, type ProductSortKey } from '@nymbalhq/types'
import { HTMLElementBase } from '../base-element.js'

function parseKeys(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch (err) {
    console.error('[nymbal-sort-dropdown] failed to parse sort-keys attribute', err)
    return []
  }
}

/**
 * <nymbal-sort-dropdown sort-keys='[…]' value default-sort>: one option per sort key the store reports, in its order,
 * labelled from PRODUCT_SORT_LABELS. A `value` the keys lack shows `default-sort`. Choosing an option emits
 * `nymbal:sort:changed` with `{ sort }`. A `<select>` already inside it (a server render's) is the one it fills.
 */
export class NymbalSortDropdown extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return ['sort-keys', 'value', 'default-sort']
  }

  private _select: HTMLSelectElement | null = null

  /** The key the dropdown shows. */
  get value(): string {
    return this._select?.value ?? ''
  }

  connectedCallback(): void {
    this.render()
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.render()
  }

  private selectElement(): HTMLSelectElement {
    if (this._select !== null && this.contains(this._select)) return this._select
    let select = this.querySelector('select')
    if (select === null) {
      select = document.createElement('select')
      select.setAttribute('aria-label', 'Sort products')
      this.appendChild(select)
    }
    if (!select.hasAttribute('data-testid')) select.setAttribute('data-testid', 'sort-dropdown')
    select.addEventListener('change', () => {
      this.dispatchEvent(
        new CustomEvent('nymbal:sort:changed', {
          bubbles: true,
          composed: true,
          detail: { sort: select.value },
        }),
      )
    })
    this._select = select
    return select
  }

  private render(): void {
    const keys = parseKeys(this.getAttribute('sort-keys'))
    const wanted = this.getAttribute('value') ?? ''
    const fallback = this.getAttribute('default-sort') ?? DEFAULT_PRODUCT_SORT
    const selected = keys.includes(wanted) ? wanted : keys.includes(fallback) ? fallback : keys[0]

    const select = this.selectElement()
    select.replaceChildren(
      ...keys.map((key) => {
        const option = document.createElement('option')
        option.value = key
        option.textContent = PRODUCT_SORT_LABELS[key as ProductSortKey] ?? key
        return option
      }),
    )
    if (selected !== undefined) select.value = selected
  }
}
