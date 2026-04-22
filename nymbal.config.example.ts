import { defineConfig, env } from '@nymbal/config'

// Reference config showing every supported section. Consumers copy this into
// `nymbal.config.ts` at their project root. This file is intentionally not
// named `nymbal.config.ts` so it doesn't trigger config loading in the monorepo.

export default defineConfig({
  store: {
    name: 'My Store',
    currency: 'GBP',
    locale: 'en-GB',
    timezone: 'Europe/London',
  },

  template: 'astro',

  infrastructure: {
    cloud: 'local',
    commandStore: 'sqlite',
    documentStore: 'in-memory',
    eventBus: 'in-process',
    compute: 'in-process',
  },

  security: {
    adapter: 'middleware',
    rateLimit: {
      '/checkout': { requests: 10, window: '60s', action: 'block' },
      '/auth/*': { requests: 5, window: '60s', action: 'challenge' },
      '/api/*': { requests: 100, window: '60s', action: 'throttle' },
      '/webhooks/*': { requests: 200, window: '60s', action: 'throttle' },
    },
    botProtection: {
      mode: 'managed',
      allowList: ['googlebot', 'bingbot', 'stripe-webhooks'],
    },
    headers: {
      hsts: true,
      contentSecurityPolicy: 'strict',
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: 'deny',
    },
    csrf: true,
  },

  commerce: {
    payments: {
      provider: 'stripe',
      config: {
        secretKey: env('STRIPE_SECRET_KEY', 'sk_test_placeholder'),
        webhookSecret: env('STRIPE_WEBHOOK_SECRET', 'whsec_placeholder'),
      },
    },
    email: { provider: 'native' },
    reviews: { provider: 'native' },
    search: { provider: 'native' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: {
      provider: 'anthropic',
      config: { apiKey: env('ANTHROPIC_API_KEY', 'anthropic-placeholder') },
    },
  },

  http: { adapter: 'fastify', port: 3001 },

  deployment: { strategy: 'standard' },

  features: {
    staging: false,
    heartbeat: false,
    autoUpdates: false,
  },
})
