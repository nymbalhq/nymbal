import { env } from '@nymbalhq/config'
import { createFixturePaymentsAdapter, createFixtureSearchAdapter } from './adapters'

// The swap config: the repository root's config with `search` and `payments` set to `custom`, the adapters injected
// through the `adapters` export (`nymbal dev` passes it to createApp), and the API on 3011 so a custom E2E run never
// reaches the native store on 3001. Its email is SMTP into Mailpit, so the alert journeys read what the store sends;
// tests/e2e/playwright.config.ts passes the stack slot's Mailpit SMTP port as NYMBAL_E2E_SMTP_PORT. `nymbal dev --api-only` runs from this directory; the NYMBAL_E2E_TARGET values
// astro-custom and nextjs-custom start it (tests/e2e/playwright.config.ts).

export const adapters = {
  search: createFixtureSearchAdapter(),
  payments: createFixturePaymentsAdapter(),
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
      '/api/alerts/subscribe': { requests: 1000, window: '1m', action: 'block' },
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
    payments: { provider: 'custom' },
    email: {
      provider: 'smtp',
      config: {
        from: 'store@nymbal.dev',
        // An address, not `localhost`: nodemailer resolves a name IPv4 first, while a server listening on `localhost`
        // takes the system's first answer, which may be ::1.
        smtp: { host: '127.0.0.1', port: Number(env('NYMBAL_E2E_SMTP_PORT', '11025')) },
      },
    },
    reviews: { provider: 'native' },
    search: { provider: 'custom' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: { provider: 'none' },
  },
  http: {
    adapter: 'fastify',
    port: 3011,
    // The custom storefronts' origins, not the schema's default 3000 and 4321; tests/e2e/playwright.config.ts moves
    // them with the worktree's stack slot (scripts/stack.ts).
    cors: {
      allowedOrigins: env('NYMBAL_CORS_ORIGINS', 'http://localhost:4331,http://localhost:3010')
        .split(',')
        .map((origin) => origin.trim()),
    },
  },
  deployment: {
    strategy: 'standard',
  },
}
