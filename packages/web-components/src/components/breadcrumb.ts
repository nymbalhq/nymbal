import { css, html, nothing } from 'lit'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'
import { navigateOnClick } from '../navigate.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-breadcrumb',
  reactName: 'Breadcrumb',
  // `[{ label, href? }]`, from the store's home to the page itself, which is the last.
  attributes: [{ name: 'items', prop: 'items', type: 'json' }],
  events: [],
  parts: ['nav', 'item', 'current'],
  slots: [],
  children: false,
}

interface Crumb {
  label: string
  href?: string
}

/** Where the page sits: each crumb a link, the last the page itself (`aria-current="page"`). */
export class NymbalBreadcrumb extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='nav'] {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--nymbal-spacing-xs, 0.25rem);
        margin-bottom: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='item'] {
        color: var(--nymbal-color-text-muted, #71717a);
        text-decoration: none;
        transition: color var(--nymbal-transition-fast, 150ms ease);
      }
      a[part~='item']:hover {
        color: var(--nymbal-color-accent, #2563eb);
      }
      .separator {
        color: var(--nymbal-color-border, #e4e4e7);
      }
      [part~='current'] {
        color: var(--nymbal-color-text, #18181b);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
    `,
  ]

  declare items: unknown

  protected override render() {
    const items = parsedJson<Crumb[]>(this, 'items', this.items)
    if (!Array.isArray(items) || items.length === 0) return nothing
    const last = items.length - 1
    return html`
      <nav part="nav" aria-label="Breadcrumb" data-testid="breadcrumb">
        ${items.map(
          (item, i) => html`
            ${i > 0 ? html`<span class="separator" aria-hidden="true">/</span>` : nothing}
            ${i === last
              ? html`<span part="current" aria-current="page">${item.label}</span>`
              : item.href === undefined
                ? html`<span part="item">${item.label}</span>`
                : html`<a part="item" href=${item.href} @click=${navigateOnClick}
                    >${item.label}</a
                  >`}
          `,
        )}
      </nav>
    `
  }
}
