import { env } from '@nymbalhq/config'
import { createNoSearchAdapter } from './adapters'

// The no-search store: the repository root's config with search `custom`, its adapter offering no capability,
// injected through the `adapters` export; the API on 3021 and the storefronts on 4341 (Astro) and 3020 (Next.js), so
// it runs in one `gate:full` beside the native store (3001) and the custom-providers store (3011).
// `nymbal dev --api-only` runs from this directory; the NYMBAL_E2E_TARGET values astro-nosearch and nextjs-nosearch
// start it (tests/e2e/playwright.config.ts) and run only the journeys tagged @nosearch.

export const adapters = {
  search: createNoSearchAdapter(),
}

export default {
  store: {
    name: 'Nymbal Dev',
    currency: 'GBP',
    locale: 'en-GB',
    timezone: 'Europe/London',
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
    search: { provider: 'custom' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: { provider: 'none' },
  },
  http: {
    adapter: 'fastify',
    port: 3021,
    // The no-search storefronts' origins; tests/e2e/playwright.config.ts moves them with the worktree's stack slot
    // (scripts/stack.ts).
    cors: {
      allowedOrigins: env('NYMBAL_CORS_ORIGINS', 'http://localhost:4341,http://localhost:3020')
        .split(',')
        .map((origin) => origin.trim()),
    },
  },
  deployment: {
    strategy: 'standard',
  },
}
