import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeSearchCursor } from '../../src/adapters/search/native-adapter.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { shopper } from '../support/shopper.js'

// What a shopper's search leaves behind: one event for the search page's own request that found nothing, and nothing
// for every other kind of search.

/** The service method the search route calls after a miss. */
interface RecordZeroResult {
  recordZeroResult(query: string): Promise<void>
}

const TYPE = 'search.zero_results.v1'
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

let k: Kernel
let served: ServedKernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const misses = () => `zqx${randomUUID().replaceAll('-', '')}`

function search(params: Record<string, string>, headers?: Record<string, string>) {
  const qs = new URLSearchParams(params).toString()
  return shopper(served.baseUrl).call<{ total: number; items: unknown[] }>(
    'GET',
    `/api/products/search?${qs}`,
    undefined,
    headers === undefined ? {} : { headers },
  )
}

async function terms(): Promise<string[]> {
  return (await eventRows(raw, 'type = ?', [TYPE])).map(
    (row) => (row.envelope.payload as { term: string }).term,
  )
}

/** Waits until the marker term's event is logged: a request made after the others, so nothing they logged is still to come. */
async function awaitMarker(marker: string): Promise<void> {
  await search({ q: marker, origin: 'page' })
  await vi.waitFor(async () => {
    expect(await terms()).toContain(marker)
  })
}

describe('AC-18: the search page’s own miss is one trimmed, lowercased, cut event', () => {
  it('AC-18: origin=page with no results publishes one event whose only field is the term, trimmed, lowercased and cut at 100, and the answer equals the unmarked search’s', async () => {
    const miss = misses()
    const long = `${miss}${'x'.repeat(150)}`
    const raw_ = `   ${long.toUpperCase()}  `

    const marked = await search({ q: raw_, origin: 'page' })
    const plain = await search({ q: raw_ })

    expect(marked.status).toBe(200)
    expect(marked.body).toEqual(plain.body)
    expect(marked.body.data!.total).toBe(0)

    const expected = long.slice(0, 100)
    await vi.waitFor(async () => {
      expect((await terms()).filter((t) => t === expected)).toHaveLength(1)
    })
    const rows = await eventRows(raw, 'type = ?', [TYPE])
    const row = rows.find((r) => (r.envelope.payload as { term: string }).term === expected)!
    expect(Object.keys(row.envelope.payload as object)).toEqual(['term'])
    expect((row.envelope.payload as { term: string }).term).toBe(
      raw_.trim().toLowerCase().slice(0, 100),
    )
  })
})

describe('AC-19: no other search counts', () => {
  it('AC-19: a search with no origin=page, one with results, a cursor, a category or a bot’s user agent publishes nothing', async () => {
    const seeded = await seedVariant(k, 2, { priceMinor: 1000 })
    await k.services.product.update(seeded.productId, { name: 'Findable Teapot Unique' })
    await k.app.relay.drain()
    const category = await k.services.category.create({
      name: 'Teapots',
      slug: `teapots-${randomUUID()}`,
      position: 0,
    })
    await k.app.relay.drain()

    const before = await terms()
    const unmarked = misses()
    const cursored = misses()
    const inCategory = misses()
    const fromBot = misses()

    const answers = [
      await search({ q: unmarked }),
      await search({ q: 'Findable Teapot Unique', origin: 'page' }),
      await search({ q: cursored, origin: 'page', cursor: encodeSearchCursor(0) }),
      await search({ q: inCategory, origin: 'page', category: category.slug }),
      await search({ q: fromBot, origin: 'page' }, { 'user-agent': BOT_UA }),
    ]
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200])

    const marker = misses()
    await awaitMarker(marker)

    expect((await terms()).filter((t) => !before.includes(t))).toEqual([marker])
  })
})

describe('AC-20: a failing report write never breaks a search', () => {
  it('AC-20: with recordZeroResult failing, origin=page still answers 200 with the search’s answer', async () => {
    const miss = misses()
    const plain = await search({ q: miss })
    vi.spyOn(k.services.search as unknown as RecordZeroResult, 'recordZeroResult').mockRejectedValue(new Error('bus down'))

    const marked = await search({ q: miss, origin: 'page' })

    expect(marked.status).toBe(200)
    expect(marked.body).toEqual(plain.body)
  })
})
