---
'@nymbalhq/platform': minor
'@nymbalhq/config': minor
'@nymbalhq/http': minor
'nymbal': minor
'create-nymbal-app': minor
---

A new store runs in production with no config edit: `NYMBAL_JWT_SECRET` (written into `.env` by `create-nymbal-app`,
set as a platform secret by `nymbal deploy`) signs tokens when the config names no `security.auth.jwtSecret`.
`http.trustProxy` takes a hop count, and `NYMBAL_TRUST_PROXY_HOPS` sets it at run time (the deploy recipes set 1), so
rate limits key on the shopper behind the platform's proxy, not on the proxy or a forged `X-Forwarded-For`.
Breaking: `registerAllRoutes` needs `jwtSecret` (`resolveAuthSecret(config, process.env).secret`).
