---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/admin': minor
---

Admin History tabs on orders, products and customers, with `GET /api/admin/{orders,products,customers}/:id/history` and `?at=<instant with a zone>` on each admin detail read, folded from the event log back to `events.retentionDays`.
New `GET /api/admin/products/:idOrSlug` (the product edit page loads); migration `0012_event_subject`; `customer.created` and `customer.updated` carry a `customer` snapshot.
