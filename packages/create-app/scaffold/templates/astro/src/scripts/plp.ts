import { client } from '../lib/client.js'
import { formatPrice } from '../lib/format.js'

const gridContainer = document.getElementById('product-grid')
const sortSelect = document.getElementById('sort-select') as HTMLSelectElement | null
const loadMoreBtn = document.getElementById('load-more-btn')
const countEl = document.getElementById('product-count')

// Load initial from URL params
const urlParams = new URLSearchParams(window.location.search)
const initialCategory = urlParams.get('category')

function renderProductCard(product: any): string {
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
}

function renderGrid() {
  const state = client.productList.getState()
  const products = state.products ?? []

  if (!gridContainer) return

  if (products.length === 0) {
    gridContainer.innerHTML = `
      <div class="plp-empty">
        <h2 class="plp-empty-title">No products found</h2>
        <p class="plp-empty-text">Try adjusting your filters or search terms.</p>
      </div>
    `
  } else {
    gridContainer.innerHTML = products.map(renderProductCard).join('')
  }

  // Update count
  if (countEl) {
    countEl.textContent = `${products.length} product${products.length === 1 ? '' : 's'}`
  }

  // Toggle load more
  if (loadMoreBtn) {
    loadMoreBtn.style.display = state.pagination.hasMore ? '' : 'none'
  }
}

// Await the initial load before subscribing so the subscription only handles
// re-renders (sort, filter, load-more) and never fires with empty state while
// SSR content is still the source of truth.
async function init() {
  if (initialCategory) {
    await client.productList.applyFilter('category', initialCategory)
  } else {
    await client.productList.load()
  }
  client.productList.subscribe(renderGrid)
}

void init()

// Sort handler
sortSelect?.addEventListener('change', () => {
  const value = sortSelect.value
  switch (value) {
    case 'newest':
      client.productList.setSort('createdAt', 'desc')
      break
    case 'price-asc':
      client.productList.setSort('priceMinor', 'asc')
      break
    case 'price-desc':
      client.productList.setSort('priceMinor', 'desc')
      break
    case 'name-asc':
      client.productList.setSort('name', 'asc')
      break
  }
})

// Load more handler
loadMoreBtn?.addEventListener('click', () => {
  client.productList.loadMore()
})
