---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/http': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/contract-tests': minor
'@nymbalhq/importers': patch
'create-nymbal-app': patch
---

Signed-in shoppers can review a product (`POST /api/reviews`, 10 an hour per IP): one review per product, pending moderation, verified when they bought it (event `review.submitted.v1`); a guest sees "Sign in to write a review". `GET /api/products/:id/reviews` no longer publishes customer or order ids, and `GET /api/capabilities` reports `reviews`, so a reviews provider without `submit` shows no form.
Breaking for a reviews adapter or a kernel composed by hand: `ReviewSubmission` carries `author`, an adapter without `submit` rejects with `ReviewRefusedError`, and `buildServices` takes `reviews`. A scaffolded store copies `src/lib/reviews.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/reviews.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js).
