import { randomUUID } from 'node:crypto'
import type { NymbalConfig } from '@nymbalhq/config'
import { describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { freshShop, list, record, ROUTE, type Shop } from '../support/recently-viewed.js'

// AC-10 on served kernels (SQLite): `/api/recently-viewed` has a built-in bound of 600 requests a minute per IP, both
// methods counted together, blocking with 429 `rate_limit.block`; a `security.rateLimit` entry for the path replaces
// it, as it does the login rule.

const BUILT_IN = 600

async function withServed(
  configure: (c: NymbalConfig) => NymbalConfig,
  body: (s: ServedKernel) => Promise<void>,
): Promise<void> {
  const s = await serveKernel(await createKernel({ dialect: 'sqlite', configure }))
  try {
    await body(s)
  } finally {
    await s.stop()
  }
}

const withoutViewRule = (config: NymbalConfig): NymbalConfig => {
  const rateLimit = { ...config.security.rateLimit }
  delete rateLimit[ROUTE]
  return { ...config, security: { ...config.security, rateLimit } }
}

const withViewRule =
  (requests: number) =>
  (config: NymbalConfig): NymbalConfig => ({
    ...config,
    security: {
      ...config.security,
      rateLimit: {
        ...config.security.rateLimit,
        [ROUTE]: { requests, window: '1m', action: 'block' },
      },
    },
  })

/** `n` requests to the route from one IP, alternating a capture (of an unknown product) and a read; their statuses. */
async function burst(shop: Shop, n: number): Promise<number[]> {
  const statuses: number[] = []
  for (let i = 0; i < n; i += 1) {
    statuses.push(
      i % 2 === 0 ? (await record(shop, randomUUID())).status : (await list(shop)).status,
    )
  }
  return statuses
}

describe('AC-10: the capture route’s rate bound', () => {
  it('AC-10: with the built-in rules, 600 requests to /api/recently-viewed from one IP in a minute, POST and GET together, are answered, and the 601st is the first refused, 429 rate_limit.block', async () => {
    await withServed(withoutViewRule, async (s) => {
      const shop = await freshShop(s.baseUrl)
      const statuses = await burst(shop, BUILT_IN)
      const blocked = await list(shop)
      statuses.push(blocked.status)

      expect(statuses.indexOf(429), 'the first refused request').toBe(statuses.length - 1)
      expect(statuses.length).toBe(BUILT_IN + 1)
      expect(blocked.body.error?.code).toBe('rate_limit.block')
    })
  }, 60_000)

  it('AC-10: a security.rateLimit entry for /api/recently-viewed replaces the built-in: at 650 the first refused is the 651st; at 3 it is the 4th', async () => {
    for (const requests of [650, 3]) {
      await withServed(withViewRule(requests), async (s) => {
        const statuses = await burst(await freshShop(s.baseUrl), requests + 1)
        expect(statuses.indexOf(429), `at ${requests}: the first refused request`).toBe(requests)
        expect(statuses.length).toBe(requests + 1)
      })
    }
  }, 60_000)
})
