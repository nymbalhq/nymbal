# @nymbalhq/sdk

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- The product-list store reports `loading: true` first, so a server-rendered grid keeps its cards until the store
  settles.

## 1.1.0

- `products.search(query, { limit, cursor, category })` returns `total` and `facets`; the search store gains
  `loadMore()` and `setCategory()`.
- `client.capabilities.get()` reads the store's capabilities; `registerPaymentDriver` adds a payment driver.

## 1.0.0

- Versioned with the other packages; no changes of its own.

## 0.2.0

- First release under `@nymbalhq`.
- Sends the CSRF token on every write, and refetches it once on `csrf.invalid`.
- `checkout.submitPayment()` resolves to the server's result, `paymentStatus` follows the server, and
  `checkout.markConfirmed()` is new.
- `client.customer.addresses` and `client.customer.orders` call the account routes.
- **Breaking:** `productList.setSort(key)` takes a `ProductSortKey`.
