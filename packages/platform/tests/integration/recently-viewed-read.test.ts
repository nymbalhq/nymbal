import type { NymbalConfig } from '@nymbalhq/config'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant } from '../support/kernel.js'
import { freshShop, liftedViewLimit, list, record, type Shop } from '../support/recently-viewed.js'

// AC-5 on served kernels (SQLite), on a clock the test sets (Date faked, timers real): the served list is the stored
// one less the products that are not active rows now and the views older than min(30 days, events.retentionDays).
// Unpublishing a product takes it out of every list and publishing it again brings it back at its own view time;
// deleting it takes it out; a product viewed again moves to the front.

const MINUTE = 60_000
const DAY = 86_400_000

function withRetention(days: number) {
  return (config: NymbalConfig): NymbalConfig =>
    liftedViewLimit({ ...config, events: { ...config.events, retentionDays: days } })
}

/** Records each view at its own instant, then puts the clock back at `now`. */
async function viewAt(shop: Shop, views: Array<[string, number]>, now: number): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'], now: views[0]?.[1] ?? now })
  try {
    for (const [productId, at] of views) {
      vi.setSystemTime(at)
      const res = await record(shop, productId)
      expect(res.status, `the view of ${productId}`).toBe(204)
    }
  } finally {
    vi.setSystemTime(now)
  }
}

async function served(shop: Shop): Promise<string[] | null> {
  const read = await list(shop)
  expect(read.status).toBe(200)
  return read.ids
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AC-5: what GET /api/recently-viewed leaves out at read time (sqlite)', () => {
  let s: ServedKernel

  beforeAll(async () => {
    s = await serveKernel(await createKernel({ dialect: 'sqlite', configure: withRetention(90) }))
  }, 60_000)

  afterAll(async () => {
    await s?.stop()
  })

  it('AC-5: of A, B, C (newest first), unpublishing B serves A, C; publishing it again serves A, B, C; deleting A serves B, C; C viewed again moves to the front', async () => {
    const [a, b, c] = [
      (await seedVariant(s.kernel, 3)).productId,
      (await seedVariant(s.kernel, 3)).productId,
      (await seedVariant(s.kernel, 3)).productId,
    ] as const
    const shop = await freshShop(s.baseUrl)
    const t = Date.now() - 10 * MINUTE
    await viewAt(
      shop,
      [
        [c, t],
        [b, t + MINUTE],
        [a, t + 2 * MINUTE],
      ],
      t + 3 * MINUTE,
    )
    const all = await served(shop)
    expect(all).toEqual([a, b, c])

    await s.kernel.services.product.unpublish(b)
    expect(await served(shop), 'B unpublished').toEqual(all!.filter((id) => id !== b))

    await s.kernel.services.product.publish(b)
    expect(await served(shop), 'B published again').toEqual(all)

    await s.kernel.services.product.delete(a)
    const left = await served(shop)
    expect(left, 'A deleted').toEqual(all!.filter((id) => id !== a))

    await viewAt(shop, [[c, t + 4 * MINUTE]], t + 5 * MINUTE)
    expect(await served(shop), 'C viewed again').toEqual([c, ...left!.filter((id) => id !== c)])
  })

  it('AC-5: with events.retentionDays 90, a view 31 days old is not served and one 29 days old is', async () => {
    const [old, recent] = [
      (await seedVariant(s.kernel, 3)).productId,
      (await seedVariant(s.kernel, 3)).productId,
    ] as const
    const shop = await freshShop(s.baseUrl)
    const now = Date.now()
    await viewAt(
      shop,
      [
        [old, now - 31 * DAY],
        [recent, now - 29 * DAY],
      ],
      now,
    )
    expect(await served(shop)).toEqual([recent])
  })
})

describe('AC-5: the read window is capped by events.retentionDays (sqlite)', () => {
  let s: ServedKernel

  beforeAll(async () => {
    s = await serveKernel(await createKernel({ dialect: 'sqlite', configure: withRetention(7) }))
  }, 60_000)

  afterAll(async () => {
    await s?.stop()
  })

  it('AC-5: with events.retentionDays 7, a view 8 days old is not served and one 6 days old is', async () => {
    const [old, recent] = [
      (await seedVariant(s.kernel, 3)).productId,
      (await seedVariant(s.kernel, 3)).productId,
    ] as const
    const shop = await freshShop(s.baseUrl)
    const now = Date.now()
    await viewAt(
      shop,
      [
        [old, now - 8 * DAY],
        [recent, now - 6 * DAY],
      ],
      now,
    )
    expect(await served(shop)).toEqual([recent])
  })
})
