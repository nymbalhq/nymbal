import { env } from '@nymbalhq/config'
import { EASYPOST_TEST_WEBHOOK_SECRET } from '../../../support/easypost'
import { MAILGUN_TEST_SIGNING_KEY } from '../../../support/mailgun'
import { createFixturePaymentsAdapter, createFixtureSearchAdapter } from './adapters'
import { HEARTBEAT_ADDRESS, HEARTBEAT_EMAIL } from './heartbeat'

// The swap config: the repository root's config with `search` and `payments` set to `custom`, the adapters injected
// through the `adapters` export (`nymbal dev` passes it to createApp), and the API on 3011 so a custom E2E run never
// reaches the native store on 3001. Its prices include tax, at 20% to a GB address, so the swap runs show an inclusive
// order's tax. Its email is Mailgun with the SMTP relay pointed at Mailpit, so the alert journeys
// read what the store sends, and its webhook signing key is the tests' own, so a journey signs Mailgun's bounces and
// complaints; tests/e2e/playwright.config.ts passes the stack slot's Mailpit SMTP port as NYMBAL_E2E_SMTP_PORT. Its
// shipping is EasyPost with the tests' webhook secret, so a journey signs EasyPost's tracker updates.
// `nymbal dev --api-only` runs from this directory; the NYMBAL_E2E_TARGET values astro-custom and nextjs-custom start
// it (tests/e2e/playwright.config.ts).

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
    // The order email links here. One API serves both custom storefronts, so a journey opens the mailed link's path
    // and query on its own storefront: the key belongs to the API, not to an origin.
    url: env('NYMBAL_STOREFRONT_URL', 'http://localhost:4331'),
    // An inclusive total is the shelf prices' sum, so the other journeys on this store keep their totals.
    pricesIncludeTax: true,
  },
  template: 'astro',
  infrastructure: {
    commandStore: env('NYMBAL_COMMAND_STORE', 'sqlite'),
    documentStore: { provider: env('NYMBAL_DOCUMENT_STORE', 'in-memory') },
    eventBus: { provider: env('NYMBAL_EVENT_BUS', 'in-process') },
    redis: { prefix: env('NYMBAL_REDIS_PREFIX', 'nymbal') },
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
      '/api/alerts/subscribe': { requests: 1000, window: '1m', action: 'block' },
      '/api/auth/forgot-password': { requests: 1000, window: '1m', action: 'block' },
      '/api/auth/reset-password': { requests: 1000, window: '1m', action: 'block' },
      '/api/customers/me/password': { requests: 1000, window: '1m', action: 'block' },
      '/api/auth/verify-email': { requests: 1000, window: '1m', action: 'block' },
      '/api/auth/resend-verification': { requests: 1000, window: '1m', action: 'block' },
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
      provider: 'mailgun',
      config: {
        from: 'store@nymbal.dev',
        // An address, not `localhost`: nodemailer resolves a name IPv4 first, while a server listening on `localhost`
        // takes the system's first answer, which may be ::1. Mailpit offers no AUTH, so the login is never sent.
        smtp: {
          host: '127.0.0.1',
          port: Number(env('NYMBAL_E2E_SMTP_PORT', '11025')),
          user: 'postmaster@mg.nymbal.dev',
          pass: 'mailgun-e2e-smtp-password',
          secure: false,
        },
        webhookSigningKey: MAILGUN_TEST_SIGNING_KEY,
      },
    },
    reviews: { provider: 'native' },
    search: { provider: 'custom' },
    analytics: { provider: 'native' },
    // Standard first and free, so every other journey on this store keeps its totals; Express is the paid choice.
    shipping: {
      provider: 'easypost',
      config: { webhookSecret: EASYPOST_TEST_WEBHOOK_SECRET },
      rates: [
        { id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: 3 },
        { id: 'express', name: 'Express', amountMinor: 499, estimatedDays: 1 },
      ],
    },
    tax: { provider: 'native', rates: [{ country: 'GB', percent: 20 }] },
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
      kitOrigins: env('NYMBAL_KIT_ORIGINS', '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    },
  },
  deployment: {
    strategy: 'standard',
  },
  // The heartbeat's store check: a checkout with this address is placed and cancelled, and hidden from the admin.
  features: { heartbeat: true },
  heartbeat: {
    store: { email: HEARTBEAT_EMAIL, address: HEARTBEAT_ADDRESS },
  },
}
