---
'@nymbalhq/http': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
---

The API runs on Fastify 5, drizzle-orm 0.45 and Zod 4. `FastifyHttpAdapter.registerPlugin` takes a Fastify 5 plugin, and `@nymbalhq/config` exports Zod 4 schemas.
A DELETE sent with `Content-Type: application/json` and no body now answers 400.
