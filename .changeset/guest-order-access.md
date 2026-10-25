---
'@nymbalhq/platform': minor
'create-nymbal-app': patch
---

An order page and `GET /api/orders/:orderNumber` now need the order's key (checkout answers `orderKey`, sent as the `x-nymbal-order-key` header; the page is `/order/<n>?key=<key>`) or the owner's session; anyone else gets 404. Set `store.url` so the order email links to the order. Run `nymbal migrate`.
Breaking: a store scaffolded from an older template takes four files from the new one, or its confirmation page shows "not found". Astro: `src/pages/checkout.astro`, `src/pages/order/[orderNumber].astro`, `src/scripts/order-status.ts`, `src/lib/api.ts`. Next: `app/(shopper)/checkout/CheckoutView.tsx`, `app/(shopper)/order/[orderNumber]/page.tsx`, `components/client/OrderStatusRefresh.tsx`, `lib/api.ts`.
