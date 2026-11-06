---
'@nymbalhq/config': minor
'@nymbalhq/http': minor
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'nymbal': minor
'create-nymbal-app': minor
'@nymbalhq/security-cloudflare': minor
---

Breaking: `http.trustProxy` and `NYMBAL_TRUST_PROXY_HOPS` are removed; list the proxies in front in `NYMBAL_TRUSTED_PROXIES` (default `loopback`; `uniquelocal` on Fly and Railway, which `nymbal deploy` now sets). `X-Forwarded-For` counts only from a listed proxy, and `NYMBAL_CLIENT_IP_HEADER` reads one header such as `True-Client-IP` from them.
`nymbal deploy nginx|apache|caddy` writes a web server config for your own server.
`createHttpServer` takes `network: app.network`; a security adapter may offer these values through `network()`.
