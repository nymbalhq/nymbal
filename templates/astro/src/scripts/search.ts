import { client } from '../lib/client.js'
import { formatPrice } from '../lib/format.js'

const resultsContainer = document.getElementById('search-results')
const queryLabel = document.getElementById('search-query-label')
const searchInput = document.getElementById('search-input') as HTMLInputElement | null

/** Builds an element; dynamic values go in through setAttribute and text nodes, never through markup. */
function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  node.append(...children)
  return node
}

function renderProductCard(product: any): HTMLElement {
  const slug = String(product.slug ?? '')
  const name = String(product.name ?? '')
  const imageUrl =
    product.imageUrl ??
    (Array.isArray(product.media) && product.media[0]?.url) ??
    `https://picsum.photos/seed/${encodeURIComponent(slug)}/600/600`
  const price =
    product.priceMinor != null
      ? formatPrice(product.priceMinor, product.currency ?? 'GBP')
      : ''

  const body = el('div', { class: 'product-card-body' }, el('span', { class: 'product-card-name' }, name))
  if (price) body.append(el('span', { class: 'product-card-price' }, price))

  return el(
    'a',
    { href: `/product/${encodeURIComponent(slug)}`, class: 'product-card', 'data-testid': `product-card-${slug}` },
    el('img', {
      src: String(imageUrl),
      alt: name,
      class: 'product-card-image',
      loading: 'lazy',
      width: '600',
      height: '600',
    }),
    body,
  )
}

function renderResults() {
  const state = client.search.getState()
  const results = state.results ?? []
  const query = state.query ?? ''
  const isLoading = state.loading ?? false

  if (!resultsContainer) return

  // Update query label
  if (queryLabel) {
    if (query) {
      queryLabel.replaceChildren('Results for ', el('strong', {}, `"${query}"`))
      queryLabel.style.display = ''
    } else {
      queryLabel.style.display = 'none'
    }
  }

  if (isLoading) {
    resultsContainer.innerHTML = `
      <div class="search-loading">Searching...</div>
    `
    return
  }

  if (!query) {
    resultsContainer.innerHTML = `
      <div class="search-empty">
        <div class="search-empty-icon" aria-hidden="true">&#128269;</div>
        <h2 class="search-empty-title">Search our store</h2>
        <p class="search-empty-text">Type a keyword to find products.</p>
      </div>
    `
    return
  }

  if (results.length === 0) {
    resultsContainer.innerHTML = `
      <div class="search-empty">
        <div class="search-empty-icon" aria-hidden="true">&#128269;</div>
        <h2 class="search-empty-title">No results found</h2>
        <p class="search-empty-text">Try a different search term or browse our categories.</p>
      </div>
    `
    return
  }

  resultsContainer.replaceChildren(
    el(
      'div',
      { class: 'search-results-header' },
      el('span', { class: 'search-result-count' }, `${results.length} result${results.length === 1 ? '' : 's'}`),
    ),
    el('div', { class: 'product-grid' }, ...results.map(renderProductCard)),
  )
}

client.search.subscribe(renderResults)

// Read initial query from URL
const urlParams = new URLSearchParams(window.location.search)
const initialQuery = urlParams.get('q')

if (initialQuery) {
  if (searchInput) searchInput.value = initialQuery
  client.search.search(initialQuery)
} else {
  renderResults()
}

// Listen for search input changes
searchInput?.addEventListener('input', () => {
  const value = searchInput.value.trim()
  if (value.length >= 2) {
    client.search.search(value)
    // Update URL without reload
    const url = new URL(window.location.href)
    url.searchParams.set('q', value)
    window.history.replaceState({}, '', url.toString())
  } else if (value.length === 0) {
    client.search.clearSearch()
    const url = new URL(window.location.href)
    url.searchParams.delete('q')
    window.history.replaceState({}, '', url.toString())
  }
})

// Handle search bar web component selection (navigates from dropdown selection)
document.addEventListener('nymbal:search:selected', ((e: CustomEvent) => {
  const query = e.detail?.query ?? e.detail?.product?.name
  if (query) {
    window.location.href = `/search?q=${encodeURIComponent(query)}`
  }
}) as EventListener)
