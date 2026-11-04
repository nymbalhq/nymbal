import { env } from '@nymbalhq/config'

// The assistant store: the repository root's config with `ai` on Anthropic, its declared `baseUrl` the scripted provider
// stand-in the journey starts (NYMBAL_E2E_AI_BASE_URL) and its key the journey's ANTHROPIC_API_KEY. `nymbal dev --api-only`
// runs from this directory, seeding the demo store, on a port and database of the journey's own
// (tests/e2e/journeys/admin/assistant.spec.ts), never 3001.

export default {
  store: {
    name: 'Nymbal Assistant',
    currency: 'GBP',
    locale: 'en-GB',
    timezone: 'Europe/London',
  },
  template: 'astro',
  infrastructure: {
    commandStore: 'sqlite',
    documentStore: { provider: 'in-memory' },
    eventBus: { provider: 'in-process' },
  },
  security: {
    adapter: 'middleware',
    rateLimit: {
      '/api/auth/login': { requests: 1000, window: '1m', action: 'block' },
      '/api/auth/register': { requests: 1000, window: '1m', action: 'block' },
      // Every checkout and order link request of the suite comes from one IP; the built-in limits are proven in the
      // http package.
      '/api/checkout': { requests: 1000, window: '1m', action: 'block' },
      '/api/orders/link': { requests: 1000, window: '1m', action: 'block' },
    },
    botProtection: { mode: 'managed', allowList: [] },
    headers: {
      hsts: true,
      contentSecurityPolicy: 'strict',
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: 'deny',
    },
    csrf: true,
  },
  commerce: {
    payments: { provider: 'native' },
    email: { provider: 'native' },
    reviews: { provider: 'native' },
    search: { provider: 'native' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: {
      provider: 'anthropic',
      config: { baseUrl: env('NYMBAL_E2E_AI_BASE_URL', 'http://127.0.0.1:9') },
    },
  },
  http: {
    adapter: 'fastify',
    port: 3042,
  },
  deployment: {
    strategy: 'standard',
  },
}
