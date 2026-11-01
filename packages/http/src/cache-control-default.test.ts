import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// The adapter's default for /api/: an answer with no Cache-Control of its own says `no-store`; one that sets its own
// keeps it, whatever it is; a path outside /api/ is left as its route answered it.

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

let adapter: FastifyHttpAdapter
let base = ''

beforeAll(async () => {
  adapter = new FastifyHttpAdapter({
    logger,
    security: securitySchema.parse({ adapter: 'middleware' }),
  })
  adapter.registerRoute('GET', '/api/plain', async () => ({ status: 200, body: { ok: true } }))
  // Answers with the Cache-Control the request names in `?cc=`.
  adapter.registerRoute('GET', '/api/own', async (ctx) => ({
    status: 200,
    headers: { 'Cache-Control': String(ctx.query.cc) },
    body: { ok: true },
  }))
  adapter.registerRoute('GET', '/outside/plain', async () => ({ status: 200, body: { ok: true } }))
  await adapter.start(0)
  base = `http://127.0.0.1:${adapter.boundPort}`
})

afterAll(async () => {
  await adapter?.stop().catch(() => {})
})

async function cacheControl(path: string): Promise<string | null> {
  const res = await fetch(`${base}${path}`)
  await res.body?.cancel()
  return res.headers.get('cache-control')
}

const directive = fc.oneof(
  fc.integer({ min: 0, max: 31_536_000 }).map((n) => `public, max-age=${n}`),
  fc.integer({ min: 0, max: 86_400 }).map((n) => `private, max-age=${n}`),
  fc
    .integer({ min: 1, max: 600 })
    .map((n) => `public, s-maxage=${n}, stale-while-revalidate=${n * 2}`),
  fc.constantFrom('no-cache', 'public, max-age=60', 'private, no-store'),
)

describe('Cache-Control default on the HTTP adapter', () => {
  it('AC-8: property: on one adapter, a /api/ route with no Cache-Control answers no-store, a /api/ route that sets its own keeps exactly that value, and a route outside /api/ gets none added', async () => {
    await fc.assert(
      fc.asyncProperty(directive, async (own) => {
        expect(await cacheControl(`/api/own?cc=${encodeURIComponent(own)}`)).toBe(own)
      }),
      { numRuns: 25 },
    )
    expect(await cacheControl('/outside/plain')).toBeNull()
    expect(await cacheControl('/api/plain')).toBe('no-store')
  })
})
