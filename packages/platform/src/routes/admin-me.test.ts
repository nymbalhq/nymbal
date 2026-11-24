import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import type { HttpAdapter, RequestAuth, RouteHandler } from '@nymbalhq/types'
import { registerAdminMeRoute } from './admin-me.js'

// The signed-in admin's session answer: who they are, the store's name and the currency the store sells in, which the
// admin formats product prices and customer totals with.

function configWith(currency: string): NymbalConfig {
  return nymbalConfigSchema.parse({
    store: { name: 'Corner Shop', currency, locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'stripe' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify' },
    deployment: { strategy: 'standard' },
  })
}

const silent = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
}

/** GET /api/admin/me registered against `config`, called as `auth`. */
async function me(config: NymbalConfig, auth: RequestAuth) {
  const routes = new Map<string, RouteHandler>()
  const adapter: HttpAdapter = {
    registerRoute(method, path, handler) {
      routes.set(`${method}:${path}`, handler)
    },
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  registerAdminMeRoute(adapter, { config })
  const handler = routes.get('GET:/api/admin/me')
  if (handler === undefined) throw new Error('GET /api/admin/me is not registered')
  return handler({
    method: 'GET',
    path: '/api/admin/me',
    url: 'http://localhost/api/admin/me',
    params: {},
    query: {},
    body: null,
    headers: {},
    cookies: {},
    requestId: 'req-1',
    correlationId: 'corr-1',
    logger: silent,
    ip: '127.0.0.1',
    auth,
  })
}

const NAMED = ['GBP', 'USD', 'JPY', 'KWD']
const LETTER = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
const CODE = fc.oneof(
  fc.constantFrom(...NAMED),
  fc.tuple(LETTER, LETTER, LETTER).map((letters) => letters.join('')),
)

describe('GET /api/admin/me', () => {
  it('AC-1: an admin’s session answer carries the configured store currency verbatim, with userId, roles, storeName and environment as before; a signed-in customer is refused', async () => {
    await fc.assert(
      fc.asyncProperty(CODE, fc.uuid(), async (currency, userId) => {
        const config = configWith(currency)

        const answer = await me(config, { userId, roles: ['admin'] })

        expect(answer.status).toBe(200)
        expect((answer.body as { data: unknown }).data).toEqual({
          userId,
          roles: ['admin'],
          storeName: config.store.name,
          environment: process.env['NODE_ENV'] ?? 'development',
          currency: config.store.currency,
        })

        const refused = await me(config, { userId, roles: ['customer'] })
        expect(refused.status).toBe(403)
        expect(JSON.stringify(refused.body)).not.toContain(config.store.name)
      }),
      { numRuns: 60 },
    )
  })
})
