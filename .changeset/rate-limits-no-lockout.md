---
'@nymbalhq/http': minor
'@nymbalhq/types': minor
'nymbal': minor
'create-nymbal-app': minor
---

Breaking: `http.trustProxy: true` now refuses to start in production; set `NYMBAL_TRUST_PROXY_HOPS` to the number of proxies in front, which `nymbal doctor` and the log now ask for when it is missing.
Failed logins for an email from other addresses no longer lock its owner out (each address still is); checkouts behind one address count per cart, up to 300 a minute per address; no-JS order and alert requests sent through `nymbal start` count against the shopper, except across several API processes, where they share the storefront's.
`create-nymbal-app` asks for the admin email (`--admin-email` with `--yes`) and otherwise draws a random one.
