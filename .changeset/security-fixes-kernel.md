---
'@nymbalhq/platform': minor
'@nymbalhq/config': minor
'@nymbalhq/types': minor
'@nymbalhq/http': patch
'@nymbalhq/web-components': minor
'nymbal': patch
'@nymbalhq/importers': patch
---

With the default JWT secret, `nymbal dev` listens on 127.0.0.1 only, and a custom server (`createApp` plus its own adapter) on a non-loopback host now throws `config.default_jwt_secret_exposed` outside production too: set `NYMBAL_JWT_SECRET`.
Cookies are `Secure` exactly when the public URL (`NYMBAL_PUBLIC_URL`, else `store.url`) is https; descriptions are stored sanitised (one saved before this version is not rewritten: re-save any that came from an untrusted source); a rotated refresh token replayed after 30 s signs its customer out everywhere; a 500 no longer shows a driver's message.
The WooCommerce importer fetches images only over http(s) from public addresses or the store's own host, and stores only image types.
