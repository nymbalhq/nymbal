import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// Acceptance test for P3-04 AC-7, the CORS half (spec P3-04-audit-trail, decision 9): a browser on an allowed origin
// can read the request's `x-correlation-id` and a replay's `Idempotent-Replayed`, so both are in
// Access-Control-Expose-Headers on every CORS response, a route's answer and an unmatched route's 404 alike.
// Kills: no exposedHeaders (today), or one of the two missing.

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
}

const ORIGINS = ['http://localhost:4321', 'http://localhost:3000', 'https://shop.example.com']
const REQUIRED = ['x-correlation-id', 'idempotent-replayed']

let adapter: FastifyHttpAdapter | undefined

afterAll(async () => {
  await adapter?.stop().catch(() => {})
})

async function start(): Promise<number> {
  adapter = new FastifyHttpAdapter({
    logger,
    cors: { allowedOrigins: ORIGINS, credentials: true },
    security: securitySchema.parse({ adapter: 'middleware' }),
  })
  adapter.registerRoute('GET', '/api/test', async () => ({ status: 200, body: { ok: true } }))
  await adapter.start(0)
  return adapter.boundPort
}

describe('P3-04 AC-7: CORS exposes the correlation and replay headers', () => {
  it('AC-7: property: for each allowed origin and path, Access-Control-Expose-Headers lists x-correlation-id and Idempotent-Replayed', async () => {
    const port = await start()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ORIGINS),
        fc.constantFrom('/api/test', '/api/no-such-route'),
        async (origin, path) => {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            headers: { Origin: origin },
          })
          const exposed = (res.headers.get('access-control-expose-headers') ?? '')
            .split(',')
            .map((h) => h.trim().toLowerCase())
          expect(res.headers.get('access-control-allow-origin'), `${origin} ${path}`).toBe(origin)
          expect(
            REQUIRED.filter((h) => !exposed.includes(h)),
            `${origin} ${path}: Access-Control-Expose-Headers ${JSON.stringify(exposed)}`,
          ).toEqual([])
        },
      ),
      { numRuns: 12 },
    )
  })
})
