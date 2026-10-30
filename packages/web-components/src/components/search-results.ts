import '@nymbalhq/sdk/ns/search'
import { css, html, nothing } from 'lit'
import type { SearchState } from '@nymbalhq/sdk'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'
import { buttonStyles } from '../view-styles.js'
import { NymbalProductCard } from './product-card.js'

type Shown = Pick<SearchState, 'query' | 'results' | 'total' | 'nextCursor' | 'loading'> & {
  given: boolean
}

const SCHEMA: ElementSchema = {
  tag: 'nymbal-search-results',
  reactName: 'SearchResults',
  // The search a server ran: the store's `results` (the card products) and the term they answer, shown until the
  // search store settles.
  attributes: [
    { name: 'results', prop: 'results', type: 'json' },
    { name: 'query', prop: 'query', type: 'string' },
  ],
  events: [],
  parts: [
    'query',
    'loading',
    'empty',
    'empty-icon',
    'empty-title',
    'empty-text',
    'header',
    'count',
    'grid',
    'pagination',
    'load-more',
  ],
  slots: ['no-term', 'no-results'],
  children: false,
}

/**
 * The search store's results: the term, a grid of `nymbal-product-card`s, the no-term and no-results states, and load
 * more. The page owns the term and the category (the URL and the search input) and searches; this renders the answer.
 */
export class NymbalSearchResults extends NymbalElement {
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
      [part~='query'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='loading'] {
        padding: var(--nymbal-spacing-xl, 2rem) 0;
        text-align: center;
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='empty'] {
        padding: 4rem var(--nymbal-spacing-md, 1rem);
        text-align: center;
      }
      [part~='empty-icon'] {
        font-size: 3rem;
        margin-bottom: var(--nymbal-spacing-md, 1rem);
        opacity: 0.3;
      }
      [part~='empty-title'] {
        margin: 0 0 var(--nymbal-spacing-xs, 0.25rem);
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='empty-text'] {
        max-width: 28ch;
        margin: 0 auto;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='header'] {
        margin-bottom: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='grid'] {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
        gap: var(--nymbal-spacing-lg, 1.5rem);
      }
      [part~='pagination'] {
        display: flex;
        justify-content: center;
        margin-top: var(--nymbal-spacing-xl, 2rem);
      }
    `,
  ]

  declare results: unknown
  declare query: string | undefined

  protected override stores() {
    return [this.client.search]
  }

  protected override storeSettled(): void {
    this.results = undefined
  }

  /**
   * The results a server gave while they stand (`given`), else the search store's; with neither, no search. Given
   * results are shown whether or not the server named their term.
   */
  private shown(): Shown {
    const given = parsedJson<SearchState['results']>(this, 'results', this.results)
    if (given === undefined && this.readsStores) {
      return { ...this.client.search.getState(), given: false }
    }
    const results = given ?? []
    const query = this.query ?? ''
    return { query, results, total: results.length, nextCursor: null, loading: false, given: true }
  }

  private empty(title: string, text: string, slot: string) {
    return html`
      <div part="empty">
        <div part="empty-icon" aria-hidden="true">&#128269;</div>
        <slot name=${slot}>
          <h2 part="empty-title">${title}</h2>
          <p part="empty-text">${text}</p>
        </slot>
      </div>
    `
  }

  private body(state: Shown) {
    const { results, query } = state
    // A load-more or a category change keeps the results shown until its answer replaces them.
    if (state.loading && results.length === 0) {
      return html`<div part="loading" role="status">Searching...</div>`
    }
    if (query === '' && !(state.given && results.length > 0)) {
      return this.empty('Search our store', 'Type a keyword to find products.', 'no-term')
    }
    if (results.length === 0) {
      return this.empty(
        'No results found',
        'Try a different search term or browse our categories.',
        'no-results',
      )
    }
    const total = state.total
    return html`
      <div part="header">
        <span part="count" data-testid="search-total"
          >${total} result${total === 1 ? '' : 's'}</span
        >
      </div>
      <div part="grid">
        ${results.map(
          (p) => html`<nymbal-product-card product=${JSON.stringify(p)}></nymbal-product-card>`,
        )}
      </div>
      ${state.nextCursor === null
        ? nothing
        : html`
            <div part="pagination">
              <button
                type="button"
                part="load-more"
                class="btn btn-secondary"
                data-testid="search-load-more"
                ?disabled=${state.loading}
                @click=${() => void this.client.search.loadMore()}
              >
                ${state.loading ? 'Loading...' : 'Load more'}
              </button>
            </div>
          `}
    `
  }

  protected override render() {
    const state = this.shown()
    const { query } = state
    return html`
      ${query === '' ? nothing : html`<p part="query">Results for <strong>"${query}"</strong></p>`}
      ${this.body(state)}
    `
  }
}
