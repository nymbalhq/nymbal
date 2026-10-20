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
import { NymbalPaymentElement } from './components/payment-element.js'
import { NymbalSortDropdown } from './components/sort-dropdown.js'
import { getPaymentDriver, registerPaymentDriver, type PaymentDriver } from '@nymbalhq/sdk'
import { testModeDriver } from './payment-drivers/test-mode.js'
import { stripeDriver } from './payment-drivers/stripe.js'

export type { PaymentElementStatus } from './components/payment-element.js'

export {
  NymbalAddToCart,
  NymbalCartDrawer,
  NymbalMiniCart,
  NymbalVariantSelector,
  NymbalQuantitySelector,
  NymbalSearchBar,
  NymbalProductFilter,
  NymbalToast,
  NymbalPaymentElement,
  NymbalSortDropdown,
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
    ['nymbal-payment-element', NymbalPaymentElement],
    ['nymbal-sort-dropdown', NymbalSortDropdown],
  ]
  // A driver the project registered under a built-in's name wins, as a project-defined tag does.
  const drivers: Array<[string, PaymentDriver]> = [
    ['test-mode', testModeDriver],
    ['stripe', stripeDriver],
  ]

  for (const [name, driver] of drivers) {
    if (getPaymentDriver(name) === undefined) registerPaymentDriver(name, driver)
  }
  for (const [name, ctor] of components) {
    if (!customElements.get(name)) {
      customElements.define(name, ctor)
    }
  }
}
