import '@nymbalhq/sdk/ns/product'
import type { DenormalisedProduct, DenormalisedVariant } from '@nymbalhq/sdk'
import { NymbalElement } from './base-element.js'

/**
 * An element showing one product's selected variant (its price, its stock). It renders from its attributes until the
 * product store settles on the product its `product-id` names, then from the store's selected variant. A store
 * settled on another product (the page a soft navigation left) is not this element's, so it keeps its attributes.
 */
export abstract class NymbalVariantElement extends NymbalElement {
  declare productId: string | undefined

  private following = false

  protected override stores() {
    return [this.client.product]
  }

  protected override storeSettled(): void {
    if (this.ownProduct() !== null) this.following = true
  }

  private ownProduct(): DenormalisedProduct | null {
    const { product } = this.client.product.getState()
    return product !== null && this.productId !== undefined && product.id === this.productId
      ? product
      : null
  }

  /** The store's product and its selected variant, once this element follows the store; else null. */
  protected selected(): {
    product: DenormalisedProduct
    variant: DenormalisedVariant | null
  } | null {
    if (!this.following || !this.readsStores) return null
    const product = this.ownProduct()
    if (product === null) return null
    const { selectedVariant } = this.client.product.getState()
    return { product, variant: selectedVariant ?? product.variants?.[0] ?? null }
  }
}
