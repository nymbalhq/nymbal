---
'nymbal': minor
'@nymbalhq/http': minor
'@nymbalhq/platform': minor
'create-nymbal-app': minor
---

`nymbal build --image` builds your store into one container image; `nymbal start` runs it in production on one port
(`PORT`, with `NYMBAL_PUBLIC_URL` set), answers `/ready` and drains on SIGTERM; `nymbal deploy fly|railway --dry-run`
writes `fly.toml` or `railway.json` and prints the deploy steps. New Astro stores read `NYMBAL_API_URL` at run time.
