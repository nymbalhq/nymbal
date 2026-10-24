import { env } from '@nymbalhq/config'

// The settings store: the repository root's config with `ai` on Anthropic, whose declared `baseUrl` is the stub
// provider the journey starts (NYMBAL_E2E_AI_BASE_URL) and whose `apiKey` nothing sets, so the admin's Settings page
// is where it comes from. `nymbal dev --api-only` runs from this directory on a port and database of the journey's
// own (tests/e2e/journeys/admin/settings.spec.ts), never 3001.

export default {
  store: {
    name: 'Nymbal Settings',
    currency: 'GBP',
    locale: 'en-GB',
    timezone: 'Europe/London',
  },
  template: 'astro',
  infrastructure: {
    commandStore: 'sqlite',
    documentStore: 'in-memory',
    eventBus: 'in-process',
  },
  security: {
    adapter: 'middleware',
    rateLimit: {
      '/api/auth/login': { requests: 1000, window: '1m', action: 'block' },
      '/api/auth/register': { requests: 1000, window: '1m', action: 'block' },
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
    port: 3041,
  },
  deployment: {
    strategy: 'standard',
  },
}
