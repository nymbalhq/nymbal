---
'create-nymbal-app': patch
---

A product's name or description can no longer run script on its product page, and Next.js renders the description as HTML like Astro. A store already scaffolded copies `src/lib/seo.ts`, `src/layouts/BaseLayout.astro` and `src/pages/product/[slug].astro` (Astro) or `lib/seo.ts`, `app/(catalog)/product/[slug]/page.tsx` and `app/(catalog)/home/[key]/page.tsx` (Next.js) from the new template.
Descriptions saved before this version are not rewritten, so re-save any that came from an untrusted source before upgrading a Next.js store.
