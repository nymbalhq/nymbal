import { env } from '@nymbalhq/config'

// The stores come from the environment so that one E2E suite runs on every store set (scripts/gate.ts --stores, the
// nightly matrix); unset, they are SQLite, in-memory and in-process. The Redis URL is REDIS_URL.
export default {
  store: {
    name: 'Nymbal Dev',
    currency: 'GBP',
    locale: 'en-GB',
    timezone: 'Europe/London',
    url: env('NYMBAL_STOREFRONT_URL', 'http://localhost:4321'),
  },
  template: 'astro',
  infrastructure: {
    commandStore: env('NYMBAL_COMMAND_STORE', 'sqlite'),
    documentStore: env('NYMBAL_DOCUMENT_STORE', 'in-memory'),
    eventBus: env('NYMBAL_EVENT_BUS', 'in-process'),
    redis: { prefix: env('NYMBAL_REDIS_PREFIX', 'nymbal') },
  },
  security: {
    adapter: 'middleware',
    // The E2E suite registers and logs in many times from 127.0.0.1; the built-in limits would refuse it.
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
    ai: { provider: 'none' },
  },
  http: {
    adapter: 'fastify',
    port: 3001,
    // The storefronts' origins; the E2E harness moves them with the worktree's stack slot (scripts/stack.ts).
    cors: {
      allowedOrigins: env('NYMBAL_CORS_ORIGINS', 'http://localhost:3000,http://localhost:4321')
        .split(',')
        .map((origin) => origin.trim()),
    },
  },
  deployment: {
    strategy: 'standard',
  },
}
