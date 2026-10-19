---
'@nymbalhq/platform': minor
'@nymbalhq/http': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/sdk': minor
---

Every route the store serves now passes one security guard, however the store is started.

**CSRF.** The Fastify adapter runs the guard on every route before auth and handler. A POST, PUT, PATCH or DELETE
without a `nymbal.csrf` cookie and an equal `x-csrf-token` header answers 403 `csrf.invalid`, unless the route was
registered with `csrf: false` (the Stripe webhook). `GET /api/csrf` returns the token in its body and sets the cookie.
The SDK, the admin and both templates fetch it once and send the header, and refetch once on a `csrf.invalid`. The
storefront and the API must be on the same site, as the cart cookie already requires.

**Rate limits.** Built-in rules sit under `security.rateLimit`, and a configured rule for the same path replaces its
default:

- `/api/auth/login`: 10 failed attempts per 15 minutes, per IP and per account email. A successful login clears that
  account's count. A blocked login answers 429 `rate_limit.block` with `Retry-After`, even with the right password.
- `/api/auth/register`: 10 per hour per IP.

**Breaking:** `http.trustProxy` now defaults to `false`, so `X-Forwarded-For` is ignored. Behind a proxy or load
balancer, set `http.trustProxy: true`, or every client shares the proxy's IP for rate limiting.

**Roles.** Roles moved from `customers.metadata.roles` to a `customers.roles` column (migration 0004 backfills it with
the known roles only). Tokens read the column alone, so writing `metadata` can no longer grant `admin`.
`Customer.roles` is required.

**Input validation.** Every platform route has a Zod schema in the exported `routeSchemas` registry, keyed
`"<METHOD> <path>"`. A route without one refuses to register. Params, query and body are parsed before the handler, so
unknown keys are stripped and bad input answers 400 `validation.failed` with `context.issues`.

**Error statuses.** `ValidationError` answers 400. `CheckoutError` answers 409 for `cart_empty`, `out_of_stock` and
`reservation_failed`, and 422 for `variant_missing`. `finalize_failed` stays 500.
