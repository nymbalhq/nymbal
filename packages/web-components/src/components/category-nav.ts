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
  tag: 'nymbal-category-nav',
  reactName: 'CategoryNav',
  // The categories as `GET /api/categories` serves them.
  attributes: [{ name: 'categories', prop: 'categories', type: 'json' }],
  events: [],
  parts: ['grid', 'card'],
  slots: [],
  children: false,
}

interface Category {
  slug: string
  name: string
  description?: string | null
}

/** A card per category, each a link to its listing. */
export class NymbalCategoryNav extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='grid'] {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--nymbal-spacing-md, 1rem);
      }
      @media (min-width: 641px) {
        [part~='grid'] {
          grid-template-columns: repeat(4, 1fr);
          gap: var(--nymbal-spacing-lg, 1.5rem);
        }
      }
      [part~='card'] {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 140px;
        padding: var(--nymbal-spacing-lg, 1.5rem) var(--nymbal-spacing-md, 1rem);
        text-align: center;
        text-decoration: none;
        background-color: var(--nymbal-color-surface, #ffffff);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-lg, 0.75rem);
        transition:
          border-color var(--nymbal-transition-fast, 150ms ease),
          box-shadow var(--nymbal-transition-fast, 150ms ease),
          transform var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='card']:hover {
        border-color: var(--nymbal-color-accent, #2563eb);
        box-shadow: var(--nymbal-shadow-md, 0 4px 6px rgba(0, 0, 0, 0.1));
        transform: translateY(-2px);
      }
      .name {
        font-size: var(--nymbal-font-size-base, 1rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
        color: var(--nymbal-color-text, #18181b);
      }
      .description {
        margin-top: var(--nymbal-spacing-xs, 0.25rem);
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
    `,
  ]

  declare categories: unknown

  protected override render() {
    const categories = parsedJson<Category[]>(this, 'categories', this.categories)
    if (!Array.isArray(categories) || categories.length === 0) return nothing
    return html`
      <div part="grid">
        ${categories.map(
          (c) => html`
            <a
              part="card"
              href="/category/${encodeURIComponent(c.slug)}"
              data-testid="category-${c.slug}"
              @click=${navigateOnClick}
            >
              <span class="name">${c.name}</span>
              ${c.description ? html`<span class="description">${c.description}</span>` : nothing}
            </a>
          `,
        )}
      </div>
    `
  }
}
