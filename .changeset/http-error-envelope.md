---
'@nymbalhq/http': patch
---

A body Fastify cannot parse (400, 413, 415) and a URL it cannot decode (400, 414) now answer `{ error: { code, message } }` with `x-correlation-id`, the `code` still Fastify's `FST_ERR_*`.
