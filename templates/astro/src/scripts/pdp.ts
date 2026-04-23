import { client } from '../lib/client.js'
import { formatPrice } from '../lib/format.js'

const slug = document.querySelector<HTMLElement>('[data-product-slug]')?.dataset.productSlug

if (slug) {
  client.product.loadBySlug(slug)

  client.product.subscribe(() => {
    const state = client.product.getState()
    if (!state.product) return

    const product = state.product
    const selectedVariant = state.selectedVariant ?? product.variants?.[0]

    // Update price display
    const priceEl = document.querySelector('[data-testid="product-price"]')
    if (priceEl && selectedVariant) {
      const price = formatPrice(
        selectedVariant.priceMinor ?? product.priceMinor,
        product.currency ?? 'GBP',
      )
      priceEl.innerHTML = `<span>${price}</span>`
    }

    // Update stock badge
    const stockEl = document.querySelector('[data-testid="stock-badge"]')
    if (stockEl && selectedVariant) {
      const stock = selectedVariant.stock ?? 0
      let statusClass: string
      let label: string

      if (stock <= 0) {
        statusClass = 'out-of-stock'
        label = 'Out of Stock'
      } else if (stock < 5) {
        statusClass = 'low-stock'
        label = 'Low Stock'
      } else {
        statusClass = 'in-stock'
        label = 'In Stock'
      }

      stockEl.className = `pdp-stock ${statusClass}`
      stockEl.innerHTML = `<span class="pdp-stock-dot" aria-hidden="true"></span>${label}`
    }

    // Update add-to-cart variant-id
    const addToCart = document.querySelector('nymbal-add-to-cart')
    if (addToCart && selectedVariant) {
      addToCart.setAttribute('variant-id', selectedVariant.id)
      if (selectedVariant.stock <= 0) {
        addToCart.setAttribute('disabled', '')
      } else {
        addToCart.removeAttribute('disabled')
      }
    }
  })

  // Listen for variant selection from the web component
  document.addEventListener('nymbal:variant:selected', ((e: CustomEvent) => {
    const variantId = e.detail?.variantId
    if (variantId) {
      client.product.selectVariant(variantId)
    }
  }) as EventListener)
}
