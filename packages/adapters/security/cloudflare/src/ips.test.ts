import { isIP } from 'node:net'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, resolveTrustedProxies } from '../../../../config/src/index.js'
import { CLOUDFLARE_IPS } from './ips.js'

// Cloudflare's published ranges ship with the adapter as a snapshot, for the web server configs that admit only
// Cloudflare. Each range must be one the API's own proxy list accepts, so a config written from it never holds an
// entry the API would refuse.

const config = nymbalConfigSchema.parse({
  store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
  template: 'astro',
  infrastructure: {
    commandStore: 'sqlite',
    documentStore: { provider: 'in-memory' },
    eventBus: { provider: 'in-process' },
  },
  security: { adapter: 'middleware' },
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

/** What resolveTrustedProxies makes of one entry as the whole list: the list, or the refusal's message. */
function asList(entry: string): string[] | string {
  try {
    return resolveTrustedProxies(config, { NYMBAL_TRUSTED_PROXIES: entry }).trustedProxies
  } catch (error) {
    return (error as Error).message
  }
}

describe('AC-14: the shipped snapshot of Cloudflare’s ranges', () => {
  it('AC-14: CLOUDFLARE_IPS holds IPv4 ranges and IPv6 ranges of their own family, each accepted by resolveTrustedProxies as a list entry, a non-empty etag and a fetchedAt that is a real date', () => {
    const { ipv4Cidrs, ipv6Cidrs, etag, fetchedAt } = CLOUDFLARE_IPS
    const family = (cidr: string) => isIP(cidr.split('/')[0]!)
    const all = [...ipv4Cidrs, ...ipv6Cidrs]

    expect(Math.min(ipv4Cidrs.length, ipv6Cidrs.length)).toBeGreaterThan(0)
    expect(ipv4Cidrs.map(family)).toEqual(ipv4Cidrs.map(() => 4))
    expect(ipv6Cidrs.map(family)).toEqual(ipv6Cidrs.map(() => 6))
    expect(all.map(asList)).toEqual(all.map((entry) => [entry]))
    expect(etag.trim().length).toBeGreaterThan(0)
    expect(fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(new Date(`${fetchedAt}T00:00:00Z`).toISOString().slice(0, 10)).toBe(fetchedAt)
  })
})
