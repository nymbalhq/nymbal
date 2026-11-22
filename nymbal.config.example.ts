import { defineConfig, env } from '@nymbalhq/config'

// Reference config showing every supported section. Consumers copy this into
// `nymbal.config.ts` at their project root. This file is intentionally not
// named `nymbal.config.ts` so it doesn't trigger config loading in the monorepo.

export default defineConfig({
  store: {
    name: 'My Store',
    currency: 'GBP',
    locale: 'en-GB',
    timezone: 'Europe/London',
    // Prices hold their tax (VAT-style): checkout extracts tax from them instead of adding it on top.
    pricesIncludeTax: false,
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
    shipping: {
      provider: 'native',
      // The delivery options checkout offers, in this order, priced in store.currency's minor units: the rows naming
      // the address's country, else the rows naming none. freeOverMinor makes a row free once the goods, after their
      // discount, reach it. No rows: one free Standard option everywhere.
      // rates: [
      //   { id: 'standard', name: 'Standard', countries: ['GB'], amountMinor: 399, freeOverMinor: 5000, estimatedDays: 3 },
      //   { id: 'express', name: 'Express', countries: ['GB'], amountMinor: 999, estimatedDays: 1 },
      //   { id: 'world', name: 'International', amountMinor: 1999 },
      // ],
      rates: [],
      // Or charge what the carrier quotes, with a provider that rates (EasyPost with an apiKey) and no rows above: the
      // cart is one parcel from store.shipFrom, each unit at its variant's weight or this default.
      // pricing: 'carrier',
      // defaultWeightGrams: 500,
    },
    tax: {
      provider: 'native',
      // A row per jurisdiction the store collects in: a country, or a US state by its code. A tax code's rate
      // replaces the row's percent for a product or variant carrying that code. No row: no tax. Shipping is taxed at
      // the row's percent unless the row sets taxShipping: false.
      // rates: [{ country: 'GB', percent: 20, codes: { food: 0 } }, { country: 'US', region: 'CA', percent: 7.25 }],
      rates: [],
      // When a third-party engine is down: refuse the checkout, or tax from the rates above.
      onUnavailable: 'refuse',
    },
    promotions: { provider: 'native' },
    ai: {
      provider: 'anthropic',
      config: { apiKey: env('ANTHROPIC_API_KEY', 'anthropic-placeholder') },
    },
  },

  http: { adapter: 'fastify', port: 3001 },

  deployment: { strategy: 'standard' },

  features: {
    staging: false,
    // true needs a `heartbeat` block: the store check's address, and optionally a saved card to charge and refund.
    heartbeat: false,
  },

  // A nightly look at the store's own figures, from `at` store time.
  nightShift: { enabled: true, at: '03:00' },
})
