export { registerClient, getClient } from './registry.js'
export { NymbalElement } from './base-element.js'
export { injectStyles } from './styles.js'

import { NymbalAddToCart } from './components/add-to-cart.js'
import { NymbalCartDrawer } from './components/cart-drawer.js'
import { NymbalMiniCart } from './components/mini-cart.js'
import { NymbalVariantSelector } from './components/variant-selector.js'
import { NymbalQuantitySelector } from './components/quantity-selector.js'
import { NymbalSearchBar } from './components/search-bar.js'
import { NymbalProductFilter } from './components/product-filter.js'
import { NymbalToast } from './components/toast.js'

export {
  NymbalAddToCart,
  NymbalCartDrawer,
  NymbalMiniCart,
  NymbalVariantSelector,
  NymbalQuantitySelector,
  NymbalSearchBar,
  NymbalProductFilter,
  NymbalToast,
}

export function registerComponents(): void {
  const components: Array<[string, CustomElementConstructor]> = [
    ['nymbal-add-to-cart', NymbalAddToCart],
    ['nymbal-cart-drawer', NymbalCartDrawer],
    ['nymbal-mini-cart', NymbalMiniCart],
    ['nymbal-variant-selector', NymbalVariantSelector],
    ['nymbal-quantity-selector', NymbalQuantitySelector],
    ['nymbal-search-bar', NymbalSearchBar],
    ['nymbal-product-filter', NymbalProductFilter],
    ['nymbal-toast', NymbalToast],
  ]

  for (const [name, ctor] of components) {
    if (!customElements.get(name)) {
      customElements.define(name, ctor)
    }
  }
}
