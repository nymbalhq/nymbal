---
'@nymbalhq/platform': patch
---

An admin cancel gives a pending order's stock back at once. `POST /api/checkout` answers 401 `auth.token_invalid` for an access token it cannot verify, so the client refreshes and places the order as the customer. The `payment.failed` reason for a wrong amount is now just `amount_mismatch`; the order's history note shows both amounts as money.
