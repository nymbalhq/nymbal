---
'create-nymbal-app': patch
---

Astro storefront forms submit once. Add address, profile save, login, register, place order and the review form go
through `submitOnce(form, handler)` (`src/lib/submit-once.ts`), which ignores a submit while the previous one is in
flight, so a double click or a second Enter makes one change (a double-clicked Save on the add-address form used to
create two addresses). The button is disabled while the handler runs and re-enabled when it settles, unless the
handler resolves `'leaving'` after setting `location.href`; a handler that throws or rejects releases the form. The
profile and review handlers move from inline `<script>`s to `src/scripts/profile-form.ts` and
`src/scripts/review-form.ts`.
