---
'@nymbalhq/web-components': minor
'@nymbalhq/sdk': minor
'@nymbalhq/platform': minor
'@nymbalhq/config': minor
'@nymbalhq/http': minor
---

`dist/kit.js` puts a cart on a WordPress theme with one script tag and two meta tags, and a set-up that cannot work says why in the console. `POST /api/alerts/subscribe` accepts `linkOrigin`, held to `http.cors.allowedOrigins` and the new `http.cors.kitOrigins` (a site listed there gets CORS on the cart's routes alone), and `createNymbalClient` an `alertLinkOrigin`, so alert links reach the store.
