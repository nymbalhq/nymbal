import './hydrate-support.js'
import { define } from './define.js'
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
import { NymbalCheckout } from './components/checkout.js'

/** Every element the package defines. */
export const ELEMENTS = [
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
  NymbalCheckout,
]

/**
 * Defines every element, and registers the built-in payment drivers, except a tag or driver name the project has
 * already defined: the project's wins. A page that renders a few elements passes those to `define` instead.
 */
export function registerComponents(): void {
  define(...ELEMENTS)
}
