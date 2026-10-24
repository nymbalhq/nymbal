---
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'create-nymbal-app': minor
---

The cart page, the search results and the account forms are now Nymbal elements, so a store can restyle or replace
them like the other elements.

- **New elements:** `nymbal-cart-page`, `nymbal-product-card`, `nymbal-search-results`, `nymbal-login-form`,
  `nymbal-register-form`, `nymbal-profile-form`, `nymbal-address-form` and `nymbal-address-book`. Each renders in an
  open shadow root, reads the `--nymbal-*` tokens, and lists its `parts` and `slots` in its schema. `@nymbalhq/react`
  has a generated wrapper for each one.
- **Events:**
  - `nymbal:auth:signed-in`, from login and register. The page decides where to go next.
  - `nymbal:profile:saved`.
  - `nymbal:address-book:changed`.
- **Behaviour:**
  - The cart page shows the cart's `subtotalMinor` from the API.
  - Register asks for the password twice.
  - Login and register keep the submit disabled after success, through the redirect.
  - Pressing Enter in an address field saves the address.
- **Templates:** both render the elements in place of their own cart, search-results and account-form code, so a new
  project carries about 1,700 fewer template lines.
