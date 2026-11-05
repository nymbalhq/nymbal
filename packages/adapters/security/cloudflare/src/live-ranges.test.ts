import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdapter } from './index.js'
import { startFakeCloudflare, type FakeCloudflare } from './tests/fake-cloudflare.js'
import { TOKEN, adapterContext } from './tests/support.js'

// `ips()` reads Cloudflare's live address ranges from GET /ips, for security:drift to compare with the shipped snapshot.
// The endpoint needs no token, and the adapter sends it none.

let fake: FakeCloudflare
beforeAll(async () => {
  fake = await startFakeCloudflare()
})
afterAll(async () => {
  await fake.close()
})

describe('AC-16: ips() reads the live ranges without the token', () => {
  it('AC-16: ips() answers what GET /ips holds, as etag, ipv4Cidrs and ipv6Cidrs, and its request carries no authorization header', async () => {
    const live = {
      etag: 'live-etag-6c2f1a',
      ipv4_cidrs: ['198.51.100.0/24'],
      ipv6_cidrs: ['2001:db8::/32'],
    }
    fake.setIps(live)
    const zoneId = fake.addZone({ plan: 'free', token: TOKEN })
    const adapter = createAdapter(
      adapterContext({ zoneId, apiToken: TOKEN, apiBase: fake.url }),
    ) as unknown as {
      ips(): Promise<{ etag: string; ipv4Cidrs: string[]; ipv6Cidrs: string[] }>
    }
    const before = fake.requests.length

    const answer = await adapter.ips()
    const sent = fake.requests.slice(before).filter((r) => r.path === '/ips')

    expect(answer).toEqual({
      etag: live.etag,
      ipv4Cidrs: live.ipv4_cidrs,
      ipv6Cidrs: live.ipv6_cidrs,
    })
    expect(fake.requests.length).toBe(before + 1)
    expect(sent.map((r) => [r.method, r.authorization])).toEqual([['GET', undefined]])
  })
})
