---
'create-nymbal-app': minor
---

New projects serve fragments a CDN can cache, and the Next.js template caches its catalog pages with ISR.

- **Fragments, both templates:** `/fragments/header` (cached 3600 s), `/fragments/footer` (86400), `/fragments/nav`
  (21600) and `/fragments/product/<slug>` (300) answer the page's element with `Cache-Control: public, s-maxage=…`,
  read no cookie and set none. An unknown product is a 404 with `no-store`; on Astro an API failure is a 502 with
  `no-store`, so no cache keeps a fragment the API did not send.
- **Next.js ISR:** `/` regenerates every 300 s and each product page every 60 s, built on its first request, so the
  build needs no API. The catalog reads go through Next's data cache (capabilities 3600 s, categories 21600, products
  and product 300, reviews 60; the product page reads its product at its own 60).
  `NYMBAL_CATALOG_REVALIDATE_S` replaces every one. A catalog read rejects when the API fails, so a failed page is an
  error Next does not cache and a failed regeneration keeps the last good page.
- **Next.js route groups:** `app/(catalog)` (home, product, listing, category, search) has a header whose cart count
  the mini-cart fills in the browser; `app/(shopper)` (cart, checkout, order, account) reads the cart cookie, so its
  header shows the count with JS off. The root layout and `not-found.tsx` call no API.
