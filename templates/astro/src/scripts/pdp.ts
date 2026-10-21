import { STOCK_LABELS, stockLevel } from '@nymbalhq/types'
import { client } from '../lib/client.js'
import { formatPrice } from '../lib/format.js'

const slug = document.querySelector<HTMLElement>('[data-product-slug]')?.dataset.productSlug
const addRow = document.querySelector<HTMLElement>('.pdp-add-row')
const quantity = addRow?.querySelector('nymbal-quantity-selector')
const addToCart = addRow?.querySelector('nymbal-add-to-cart')

function setQuantity(qty: number): void {
  quantity?.setAttribute('value', String(qty))
  addToCart?.setAttribute('qty', String(qty))
}

if (slug) {
  // The server rendered variants[0]; a change from it resets the quantity.
  let shownVariantId = addToCart?.getAttribute('variant-id') ?? null

  addRow?.addEventListener('nymbal:quantity:changed', ((e: CustomEvent<{ value: number }>) => {
    addToCart?.setAttribute('qty', String(e.detail.value))
  }) as EventListener)

  client.product.subscribe(() => {
    const { product, selectedVariant } = client.product.getState()
    if (!product) return
    const variant = selectedVariant ?? product.variants?.[0]

    const priceEl = document.querySelector('[data-testid="product-price"]')
    if (priceEl) {
      const price = formatPrice(
        variant?.priceMinor ?? product.priceMinor ?? 0,
        product.currency ?? 'GBP',
      )
      priceEl.innerHTML = `<span>${price}</span>`
    }

    const stock = variant?.stock ?? 0
    const level = stockLevel(stock)
    const badge = document.querySelector<HTMLElement>('[data-testid="stock-badge"]')
    if (badge) {
      badge.dataset.level = level
      const label = badge.querySelector('[data-stock-label]')
      if (label) label.textContent = STOCK_LABELS[level]
    }

    if (addToCart && variant) {
      addToCart.setAttribute('variant-id', variant.id)
      addToCart.toggleAttribute('disabled', stock <= 0)
    }

    if (variant && variant.id !== shownVariantId) {
      shownVariantId = variant.id
      setQuantity(1)
    }
  })

  client.product.loadBySlug(slug)
}
