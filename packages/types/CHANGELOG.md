# @nymbalhq/types

## 1.3.0

### Minor Changes

- 0cfbcf2: Admin History tabs on orders, products and customers: `GET /api/admin/{orders,products,customers}/:id/history`, and `?at=<instant with a zone>` on each admin detail read, back to `events.retentionDays`.
  New `GET /api/admin/products/:idOrSlug`; `customer.created` and `customer.updated` carry a `customer` snapshot. Run `nymbal migrate`.

## 1.2.0

- Audit and idempotency types: `AuditEntry`, `AuditActor`, `isValidIdempotencyKey` and the header names.
- `AdapterSetting`: a provider package declares the settings the admin can fill.
- `DocumentStoreAdapter.replaceCollection` is required, and `SearchAdapter.replaceAll` optional.
- **Breaking:** `Slot` includes `security`, and `ProviderPackage.sdk` is optional.

## 1.1.0

- `healthCheck()` on primitives, with `boundedHealthCheck` and `HEALTH_CHECK_TIMEOUT_MS` to implement it.
- `Recipe`, `stockLevel()` and `STOCK_LABELS`, `StoreCapabilities`, `PaymentClient` and `PRODUCT_SORT_LABELS`.
- `compareDocumentValues`, `matchesSortKey` and `queryDocuments`, the order every document store follows. **Breaking:**
  values of different types rank by type, so `1` and `'1'` differ, and nulls sort last.
- Search pages by cursor with a `total`, and `FacetParams.query` is new.
- `MediaStorage` lives here, and `AdapterContext.slot` is a `Slot`.

## 1.0.0

- **Breaking:** an adapter's `capabilities` is a method, `capabilities()`.

## 0.2.0

- First release under `@nymbalhq`.
- `Order` carries captured and refunded amounts, with `paymentState()` and `refundableMinor()`.
- **Breaking:** `PaymentsAdapter` gains `cancelPaymentIntent`, `getPaymentIntent` and refund options; `Customer.roles`
  is required.
- `EventBusAdapter.replay` and `ProductSortKey`.
