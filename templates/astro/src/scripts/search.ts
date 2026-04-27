import { client } from '../lib/client.js'
import { formatPrice } from '../lib/format.js'

const resultsContainer = document.getElementById('search-results')
const queryLabel = document.getElementById('search-query-label')
const searchInput = document.getElementById('search-input') as HTMLInputElement | null

function renderResults() {
  const state = client.search.getState()
  const results = state.results ?? []
  const query = state.query ?? ''
  const isLoading = state.loading ?? false

  if (!resultsContainer) return

  // Update query label
  if (queryLabel) {
    if (query) {
      queryLabel.innerHTML = `Results for <strong>"${query}"</strong>`
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

  const cardsHtml = results
    .map((product: any) => {
      const imageUrl =
        product.imageUrl ??
        (Array.isArray(product.media) && product.media[0]?.url) ??
        `https://picsum.photos/seed/${product.slug}/600/600`
      const price =
        product.priceMinor != null
          ? formatPrice(product.priceMinor, product.currency ?? 'GBP')
          : ''

      return `
        <a href="/product/${product.slug}" class="product-card" data-testid="product-card-${product.slug}">
          <img
            src="${imageUrl}"
            alt="${product.name}"
            class="product-card-image"
            loading="lazy"
            width="600"
            height="600"
          />
          <div class="product-card-body">
            <span class="product-card-name">${product.name}</span>
            ${price ? `<span class="product-card-price">${price}</span>` : ''}
          </div>
        </a>
      `
    })
    .join('')

  resultsContainer.innerHTML = `
    <div class="search-results-header">
      <span class="search-result-count">${results.length} result${results.length === 1 ? '' : 's'}</span>
    </div>
    <div class="product-grid">
      ${cardsHtml}
    </div>
  `
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
