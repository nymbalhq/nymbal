---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/admin': minor
---

Admin History tabs on orders, products and customers: `GET /api/admin/{orders,products,customers}/:id/history`, and `?at=<instant with a zone>` on each admin detail read, back to `events.retentionDays`.
New `GET /api/admin/products/:idOrSlug`; `customer.created` and `customer.updated` carry a `customer` snapshot. Run `nymbal migrate`.
