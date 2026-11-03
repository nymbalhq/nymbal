---
'create-nymbal-app': patch
---

`/products?category=<slug>` lists that category, the empty cart shows without JavaScript, the sticky header no longer covers what is scrolled into view, and on Next.js a failed capabilities read leaves a shopper page standing (no search bar) while Try Again refetches. A store already scaffolded copies `src/lib/api.ts`, `src/pages/cart.astro`, `src/pages/products/index.astro`, `src/styles/global.css` and `src/styles/pages/pdp.css` (Astro) or `lib/{api,header,chrome}.ts`, `components/server/Header.tsx`, `app/error.tsx`, `app/globals.css`, `app/(shopper)/cart/page.tsx` and `app/(catalog)/products/page.tsx` (Next.js) from the new template.
