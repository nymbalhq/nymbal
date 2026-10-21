import { css, html } from 'lit'
import { DEFAULT_PRODUCT_SORT, PRODUCT_SORT_LABELS, type ProductSortKey } from '@nymbalhq/types'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'

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

const SCHEMA: ElementSchema = {
  tag: 'nymbal-sort-dropdown',
  reactName: 'SortDropdown',
  attributes: [
    { name: 'sort-keys', prop: 'sortKeys', type: 'json' },
    { name: 'value', prop: 'value', type: 'string' },
    { name: 'default-sort', prop: 'defaultSort', type: 'string' },
  ],
  events: [{ name: 'nymbal:sort:changed', prop: 'onSortChange', detail: '{ sort: string }' }],
  parts: ['select'],
  slots: [],
  children: false,
}

/**
 * <nymbal-sort-dropdown sort-keys='[…]' value default-sort>: one option per sort key the store reports, in its order,
 * labelled from PRODUCT_SORT_LABELS. A `value` the keys lack shows `default-sort`. Choosing an option emits
 * `nymbal:sort:changed` with `{ sort }`. A `<select>` child (a server render's, so the sort works before JS) is slotted
 * and is the one it fills; with none, it renders its own `part="select"`.
 */
export class NymbalSortDropdown extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)

  static override styles = [
    baseStyles,
    css`
      [part~='select'] {
        display: block;
        width: 100%;
        min-width: 10rem;
        padding: 0.5rem 0.75rem;
        font: inherit;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        line-height: 1.5;
        color: var(--nymbal-color-text, #18181b);
        background-color: var(--nymbal-color-surface, #ffffff);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-md, 0.375rem);
        cursor: pointer;
        appearance: none;
        transition:
          border-color var(--nymbal-transition-fast, 150ms ease),
          box-shadow var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='select']:focus {
        outline: none;
        border-color: var(--nymbal-color-accent, #2563eb);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
      }
    `,
  ]

  private _wired: HTMLSelectElement | null = null

  private slottedSelect(): HTMLSelectElement | null {
    return [...this.children].find((c): c is HTMLSelectElement => c instanceof HTMLSelectElement) ?? null
  }

  private select(): HTMLSelectElement | null {
    return this.slottedSelect() ?? this.renderRoot?.querySelector('select[part~="select"]') ?? null
  }

  protected override render() {
    return this.slottedSelect() !== null
      ? html`<slot></slot>`
      : html`<select part="select" data-testid="sort-dropdown" aria-label="Sort products"></select>`
  }

  protected override updated(): void {
    const select = this.select()
    if (select === null) return
    if (this._wired !== select) {
      select.addEventListener('change', this.handleChange)
      this._wired = select
    }

    const keys = parseKeys(this.getAttribute('sort-keys'))
    const wanted = this.getAttribute('value') ?? ''
    const fallback = this.getAttribute('default-sort') ?? DEFAULT_PRODUCT_SORT
    const selected = keys.includes(wanted) ? wanted : keys.includes(fallback) ? fallback : keys[0]
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

  private handleChange = (e: Event): void => {
    this.dispatchEvent(
      new CustomEvent('nymbal:sort:changed', {
        bubbles: true,
        composed: true,
        detail: { sort: (e.target as HTMLSelectElement).value },
      }),
    )
  }
}
