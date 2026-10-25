import { NymbalAddToCart } from '@nymbalhq/web-components/elements/nymbal-add-to-cart'
import { NymbalBreadcrumb } from '@nymbalhq/web-components/elements/nymbal-breadcrumb'
import { NymbalImageGallery } from '@nymbalhq/web-components/elements/nymbal-image-gallery'
import { NymbalNotifyMe } from '@nymbalhq/web-components/elements/nymbal-notify-me'
import { NymbalProductGrid } from '@nymbalhq/web-components/elements/nymbal-product-grid'
import { NymbalProductPrice } from '@nymbalhq/web-components/elements/nymbal-product-price'
import { NymbalQuantitySelector } from '@nymbalhq/web-components/elements/nymbal-quantity-selector'
import { NymbalReviewForm } from '@nymbalhq/web-components/elements/nymbal-review-form'
import { NymbalReviewList } from '@nymbalhq/web-components/elements/nymbal-review-list'
import { NymbalStockBadge } from '@nymbalhq/web-components/elements/nymbal-stock-badge'
import { NymbalVariantSelector } from '@nymbalhq/web-components/elements/nymbal-variant-selector'
import { client } from '../lib/client.js'

NymbalBreadcrumb.define()
NymbalImageGallery.define()
NymbalProductPrice.define()
NymbalStockBadge.define()
NymbalVariantSelector.define()
NymbalQuantitySelector.define()
NymbalAddToCart.define()
NymbalReviewList.define()
NymbalReviewForm.define()
// The related grid is there only when the product has relations.
if (document.querySelector('nymbal-product-grid') !== null) NymbalProductGrid.define()
// The back-in-stock form is there only when the store's email delivers.
if (document.querySelector('nymbal-notify-me') !== null) NymbalNotifyMe.define()

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

  // The price and the stock badge follow the store themselves; the add row is the page's.
  client.product.subscribe(() => {
    const { product, selectedVariant } = client.product.getState()
    if (!product) return
    const variant = selectedVariant ?? product.variants?.[0]

    if (addToCart && variant) {
      addToCart.setAttribute('variant-id', variant.id)
      addToCart.toggleAttribute('disabled', (variant.stock ?? 0) <= 0)
    }

    if (variant && variant.id !== shownVariantId) {
      shownVariantId = variant.id
      setQuantity(1)
    }
  })

  client.product.loadBySlug(slug)
}
