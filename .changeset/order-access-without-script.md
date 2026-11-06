---
'create-nymbal-app': patch
---

The order page reopens an expired order link by email and sends "send me my order link" without JavaScript, and a signed-in shopper opening their own order's link lands on their account's order page. A store already scaffolded copies the order page, `src/lib/api.ts` and `src/scripts/order-access.ts` (Astro) or `app/(shopper)/order/[orderNumber]/` and `lib/api.ts` (Next.js) from the new template; the Next.js order route now sends `Referrer-Policy: strict-origin`.
