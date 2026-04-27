export default {
  store: {
    name: 'Nymbal Dev',
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
    rateLimit: {},
    botProtection: { mode: 'managed', allowList: [] },
    headers: { hsts: true, contentSecurityPolicy: 'strict', referrerPolicy: 'strict-origin-when-cross-origin', xFrameOptions: 'deny' },
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
  },
  deployment: {
    strategy: 'standard',
  },
}
