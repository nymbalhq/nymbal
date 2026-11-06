import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, resolveTrustedProxies } from '../../../../config/src/index.js'
import { createAdapter } from './index.js'
import { adapterContext } from './tests/support.js'

// The Cloudflare adapter offers the API one network setting: read the shopper's address from CF-Connecting-IP, and
// only on a request the origin lock admitted. It lists no proxies (Cloudflare's ranges as trusted proxies would let any
// client behind them choose its address), and a store's own header replaces its offer, the lock flag with it.

const config = nymbalConfigSchema.parse({
  store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
  template: 'astro',
  infrastructure: {
    commandStore: 'sqlite',
    documentStore: { provider: 'in-memory' },
    eventBus: { provider: 'in-process' },
  },
  security: {
    adapter: 'cloudflare',
    cloudflare: { zoneId: 'zone-network', apiToken: 'token-network' },
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
  http: { adapter: 'fastify' },
  deployment: { strategy: 'standard' },
})

describe('AC-7: the Cloudflare adapter asks for CF-Connecting-IP behind the lock', () => {
  it('AC-7: network() is exactly { clientIpHeader: CF-Connecting-IP, clientIpRequiresLock: true }; resolved with nothing set, the header is the adapter’s with the lock flag; with NYMBAL_CLIENT_IP_HEADER=True-Client-IP the store’s header wins and the flag is false', () => {
    const adapter = createAdapter(adapterContext({ zoneId: 'z', apiToken: 't' })) as unknown as {
      network(): Record<string, unknown>
    }
    const offer = adapter.network()
    const contribution = { adapter: 'cloudflare', network: offer }

    const byAdapter = resolveTrustedProxies(config, {}, contribution)
    const byStore = resolveTrustedProxies(
      config,
      { NYMBAL_CLIENT_IP_HEADER: 'True-Client-IP' },
      contribution,
    )

    expect(offer).toEqual({ clientIpHeader: 'CF-Connecting-IP', clientIpRequiresLock: true })
    expect(byAdapter.trustedProxies).toEqual(resolveTrustedProxies(config, {}).trustedProxies)
    expect([
      byAdapter.clientIpHeader,
      byAdapter.clientIpHeaderSource,
      byAdapter.clientIpRequiresLock,
    ]).toEqual(['CF-Connecting-IP', { kind: 'adapter', name: 'cloudflare' }, true])
    expect([byStore.clientIpHeader, byStore.clientIpRequiresLock]).toEqual([
      'True-Client-IP',
      false,
    ])
  })
})
