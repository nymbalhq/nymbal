import type { ProductSortKey } from '@nymbalhq/types'
import { client } from '../lib/client.js'
import { escapeHtml, formatPrice } from '../lib/format.js'

const gridContainer = document.getElementById('product-grid')
const sortSelect = document.getElementById('sort-select') as HTMLSelectElement | null
const loadMoreBtn = document.getElementById('load-more-btn')
const countEl = document.getElementById('product-count')

// A category page carries its category in the path, which the server render puts on the grid; /products may carry
// one in the query. The server render also selected the URL's sort in the dropdown.
const urlParams = new URLSearchParams(window.location.search)
const initialCategory = gridContainer?.dataset.category ?? urlParams.get('category') ?? undefined
const initialSort = (sortSelect?.value ?? 'newest') as ProductSortKey

function renderProductCard(product: any): string {
  const imageUrl =
    product.imageUrl ??
    (Array.isArray(product.media) && product.media[0]?.url) ??
    `https://picsum.photos/seed/${product.slug}/600/600`
  // The "from" price, which the price sorts order by.
  const fromMinor = product.priceRange?.minMinor ?? product.priceMinor
  const price = fromMinor != null ? formatPrice(fromMinor, product.currency ?? 'GBP') : ''

  const slug = escapeHtml(product.slug)
  const name = escapeHtml(product.name)

  return `
    <a href="/product/${slug}" class="product-card" data-testid="product-card-${slug}">
      <img
        src="${escapeHtml(imageUrl)}"
        alt="${name}"
        class="product-card-image"
        loading="lazy"
        width="600"
        height="600"
      />
      <div class="product-card-body">
        <span class="product-card-name">${name}</span>
        ${price ? `<span class="product-card-price">${escapeHtml(price)}</span>` : ''}
      </div>
    </a>
  `
}

function renderGrid() {
  const state = client.productList.getState()
  const products = state.products ?? []

  if (!gridContainer) return

  // Don't overwrite the grid with an empty state while a load is in flight.
  // This prevents the SSR content from being replaced by "No products found"
  // during the brief window between applyFilter setting filters and the API
  // responding with the filtered set.
  if (products.length === 0 && state.loading) return

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

// The first load's own answer is the server-rendered grid, so it is not re-rendered: subscribing after it keeps the
// subscription to re-renders (sort, filter, load-more). A sort or filter chosen while it was in flight reached the
// store with nothing subscribed, so that state is rendered here.
async function init() {
  await client.productList.load({ limit: 24, category: initialCategory, sort: initialSort })
  client.productList.subscribe(renderGrid)
  const state = client.productList.getState()
  const filters = Object.entries(state.filters)
  const changed =
    state.sort !== initialSort ||
    filters.length !== (initialCategory === undefined ? 0 : 1) ||
    filters.some(([name, value]) => name !== 'category' || value !== initialCategory)
  if (state.loading || changed) renderGrid()
}

void init()

// The URL carries the sort, so a reload or a shared link renders the same order server-side.
sortSelect?.addEventListener('change', () => {
  const sort = sortSelect.value as ProductSortKey
  const url = new URL(window.location.href)
  url.searchParams.set('sort', sort)
  window.history.replaceState(window.history.state, '', url)
  void client.productList.setSort(sort)
})

// Load more handler
loadMoreBtn?.addEventListener('click', () => {
  client.productList.loadMore()
})
