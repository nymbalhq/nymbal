export { registerClient, getClient } from './registry.js'
export { NymbalElement } from './base-element.js'
export type { ElementSchema, ElementAttributeType } from './base-element.js'

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
import { NymbalCartPage } from './components/cart-page.js'
import { NymbalProductCard } from './components/product-card.js'
import { NymbalSearchResults } from './components/search-results.js'
import { NymbalLoginForm } from './components/login-form.js'
import { NymbalRegisterForm } from './components/register-form.js'
import { NymbalProfileForm } from './components/profile-form.js'
import { NymbalAddressForm } from './components/address-form.js'
import { NymbalAddressBook } from './components/address-book.js'
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
  NymbalCartPage,
  NymbalProductCard,
  NymbalSearchResults,
  NymbalLoginForm,
  NymbalRegisterForm,
  NymbalProfileForm,
  NymbalAddressForm,
  NymbalAddressBook,
}

const ELEMENTS = [
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
  NymbalCartPage,
  NymbalProductCard,
  NymbalSearchResults,
  NymbalLoginForm,
  NymbalRegisterForm,
  NymbalProfileForm,
  NymbalAddressForm,
  NymbalAddressBook,
]

/** Defines every element under its schema's tag, except a tag the project has already defined: the project's wins. */
export function registerComponents(): void {
  // A driver the project registered under a built-in's name wins, as a project-defined tag does.
  const drivers: Array<[string, PaymentDriver]> = [
    ['test-mode', testModeDriver],
    ['stripe', stripeDriver],
  ]

  for (const [name, driver] of drivers) {
    if (getPaymentDriver(name) === undefined) registerPaymentDriver(name, driver)
  }
  for (const element of ELEMENTS) {
    if (!customElements.get(element.schema.tag)) {
      customElements.define(element.schema.tag, element)
    }
  }
}
