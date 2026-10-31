---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/contract-tests': minor
---

Shipping adapters can report tracking updates from `receiveWebhook` as `<provider>.tracking.v1`; a delivered update
marks the shipped order delivered. `runShippingTrackingContract` certifies a shipping adapter's tracking updates.
Breaking for a kernel composed by hand: `registerHandlers` takes `orders` (the order service).
