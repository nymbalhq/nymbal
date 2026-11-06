---
'create-nymbal-app': patch
---

Signing in follows `?redirect` only to a path on the store's own origin; anything else goes to `/account`.
A store already scaffolded copies `lib/signed-in-target.ts` (Next.js) or `src/scripts/signed-in-redirect.ts` (Astro)
from the new template.
