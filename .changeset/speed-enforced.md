---
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'@nymbalhq/platform': patch
'@nymbalhq/cli': patch
'create-nymbal-app': patch
---

Every page loads only the elements it renders, and the templates carry performance budgets.

- **Per-element entry points:** `@nymbalhq/web-components/elements/<tag>` exports one element with a static
  `define()`; the package has no import-time side effects (`sideEffects: ["*.css"]`), so a bundler drops what a page
  does not import. `registerComponents()` still defines everything for a page that wants that. Payment drivers
  register in the payment element's `beforeDefine`, not at import.
- **React:** `@nymbalhq/react`'s root is a facade of pure re-exports; each generated wrapper defines its own element
  in an effect and imports its element's entry point, so Turbopack and webpack tree-shake per page. `NymbalSetup`
  defines the layout's elements.
- **Templates:** each Astro page's module script and each Next route define exactly what they render; the checkout
  page reserves `nymbal-checkout`'s box before it upgrades, so the footer stays put (CLS 0.68 → 0.01).
- **Budgets:** `pnpm perf:budgets` measures LCP, CLS, TBT and script bytes on the home, listing, product, cart and
  checkout pages of both templates against `perf-budgets.json` (whole-KiB script budgets at the measured value + 5%;
  the Next cart keeps a 3000 ms LCP exception until server rendering); it refuses ports something else listens on. CI
  runs it, and the production E2E that proves per-page loading, in the `perf-budgets` job.
- **Fixes:** Astro listing images are no longer lazy above the fold (LCP); the Next filter panel is not rendered on
  phones (CLS); the Next cart no longer shifts after hydration.
