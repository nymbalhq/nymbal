import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchDocument } from '@nymbalhq/types'
import { startFakeAlgolia, type FakeAlgolia } from './tests/fake-algolia.js'
import { adapterOn, algoliaConfig, isBatchRequest, productDoc } from './tests/support.js'

// AC-2: replaceAll on the fake Algolia. Afterwards the live index holds exactly the documents given, whatever it held
// before; a reader searching while the upload runs sees the old catalogue or the new one, never part of each; the
// upload goes in chunks of at most 1000. Each case has a fake of its own, so the indexes it lists are the case's.

let fake: FakeAlgolia

beforeEach(async () => {
  fake = await startFakeAlgolia()
})
afterEach(async () => {
  await fake.close()
})

const docsFor = (token: string, ids: readonly number[], tag = ''): SearchDocument[] =>
  ids.map((n) => productDoc(`${token}-${tag}${n}`, { name: `${token} item ${n}` }))

async function* streamed(docs: SearchDocument[]): AsyncGenerator<SearchDocument> {
  yield* docs
}

describe('AC-2: replaceAll replaces the whole index', () => {
  it('AC-2: property: over generated before and after sets, after replaceAll the live index holds exactly the after set, search finds exactly it, the settings are kept and no other index is left', async () => {
    const config = algoliaConfig(fake.host)
    const adapter = await adapterOn(config)
    const settings = fake.settings(config.indexName)
    const ids = fc.uniqueArray(fc.integer({ min: 0, max: 40 }), { maxLength: 25 })

    await fc.assert(
      fc.asyncProperty(ids, ids, fc.boolean(), async (before, after, asStream) => {
        const token = `t${randomUUID().replace(/-/g, '').slice(0, 15)}`
        await adapter.index(docsFor(token, before))
        const wanted = docsFor(token, after)

        await adapter.replaceAll!(asStream ? streamed(wanted) : wanted)

        const held = fake
          .records(config.indexName)
          .map((r) => r.objectID)
          .sort()
        expect(held).toEqual(wanted.map((d) => d.id).sort())
        const found = await adapter.search(token, { limit: 100 })
        expect(found.items.map((d: SearchDocument) => d.id).sort()).toEqual(held)
        expect(found.total).toBe(wanted.length)
        expect(fake.settings(config.indexName)).toEqual(settings)
        expect(fake.indexes()).toEqual([config.indexName])
      }),
      { numRuns: 20 },
    )
  }, 60_000)

  it('AC-2: a search during the upload of 2300 documents over 1500 others finds the old set or the new set, never a mix, and every chunk holds at most 1000', async () => {
    const OLD = 1500
    const NEW = 2300
    const config = algoliaConfig(fake.host)
    const adapter = await adapterOn(config)
    const token = `t${randomUUID().replace(/-/g, '').slice(0, 15)}`
    const old = docsFor(
      token,
      Array.from({ length: OLD }, (_, i) => i),
      'old-',
    )
    for (let i = 0; i < old.length; i += 500) await adapter.index(old.slice(i, i + 500))
    const fresh = docsFor(
      token,
      Array.from({ length: NEW }, (_, i) => i),
      'new-',
    )
    const oldIds = new Set(old.map((d) => d.id))
    const newIds = new Set(fresh.map((d) => d.id))

    const seen: Array<{ total: number; ids: string[] }> = []
    const chunks: number[] = []
    fake.intercept(async (request) => {
      if (!isBatchRequest(request)) return
      const ops = (request.body as { requests?: Array<{ action?: string }> } | null)?.requests ?? []
      chunks.push(ops.filter((o) => o.action === 'addObject' || o.action === 'updateObject').length)
      const page = await adapter.search(token, { limit: 50 })
      seen.push({ total: page.total, ids: page.items.map((d: SearchDocument) => d.id) })
    })
    try {
      await adapter.replaceAll!(fresh)
    } finally {
      fake.intercept(null)
    }

    const mixed = seen.filter(
      ({ total, ids }) =>
        !(total === OLD && ids.every((id) => oldIds.has(id))) &&
        !(total === NEW && ids.every((id) => newIds.has(id))),
    )
    expect(mixed).toEqual([])
    expect(seen.length).toBeGreaterThanOrEqual(Math.ceil(NEW / 1000))
    expect(Math.max(...chunks)).toBeLessThanOrEqual(1000)
    expect(chunks.reduce((sum, n) => sum + n, 0)).toBe(NEW)
    const held = new Set(fake.records(config.indexName).map((r) => r.objectID))
    expect(held).toEqual(newIds)
  }, 60_000)
})
