import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdapterError, ConfigError, type SearchDocument, type SearchResult } from '@nymbalhq/types'
import { createAlgoliaSearchAdapter } from './index.js'
import {
  QUERY_LIMIT_BYTES,
  RECORD_LIMIT_BYTES,
  startFakeAlgolia,
  startSilentServer,
  type AlgoliaRecord,
  type FakeAlgolia,
} from './tests/fake-algolia.js'
import {
  MAX_TERM,
  adapterOn,
  algoliaConfig,
  capturingLogger,
  isSearchRequest,
  nativeTerms,
  productDoc,
  sentQueries,
} from './tests/support.js'

// The adapter against the fake Algolia. AC-3: the index settings initialize writes, and the record each product
// becomes (its terms are native's, capped, first of each kept; a record over 10 KB keeps the leading terms that fit).
// AC-1's query half: a query is sent as its capped terms, at most 512 bytes. AC-4: a hung Algolia fails within the
// 5 s timeout, and an HTTP error says Algolia's status and message without the key.

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

let fake: FakeAlgolia

beforeAll(async () => {
  fake = await startFakeAlgolia()
})
afterAll(async () => {
  await fake.close()
})

const settingsWrites = (index: string): unknown[] =>
  fake.requests
    .filter((r) => r.method === 'PUT' && r.index === index && r.path.endsWith('/settings'))
    .map((r) => r.body)

describe('AC-3: initialize sets the index to match as native does', () => {
  it('AC-3: initialize leaves the index with exactly the matching settings, and a second initialize sends the same settings and changes none', async () => {
    const config = algoliaConfig(fake.host)
    const adapter = await adapterOn(config)
    const firstWrites = settingsWrites(config.indexName)
    const once = fake.settings(config.indexName)

    await adapter.initialize({ ...config })
    const secondWrites = settingsWrites(config.indexName).slice(firstWrites.length)
    const twice = fake.settings(config.indexName)

    const { paginationLimitedTo, ...matching } = once ?? {}
    expect(matching).toEqual({
      searchableAttributes: ['_terms'],
      attributesForFaceting: ['categoryIds'],
      queryType: 'prefixAll',
      typoTolerance: false,
      ignorePlurals: false,
      removeStopWords: false,
      advancedSyntax: false,
    })
    // The contract walks up to 300 matches one page at a time.
    expect(Number(paginationLimitedTo)).toBeGreaterThanOrEqual(300)
    expect(secondWrites).toEqual(firstWrites)
    expect(twice).toEqual(once)
  })
})

describe("AC-3: a record's terms are native's", () => {
  const piece = fc.oneof(
    fc.stringMatching(/^[a-z0-9]{1,6}$/),
    fc.stringMatching(/^[A-Z][a-z]{0,5}$/),
    fc.constantFrom(
      'Café',
      'naïve',
      'ÉCLAIR',
      'x-ray',
      "o'neil",
      'a.b.c',
      'v2.0',
      '!!!',
      '日本',
      '_',
    ),
    fc.string({ unit: 'binary', maxLength: 5 }),
    // Past MAX_TERM: capped, and two that share their first MAX_TERM characters are one term.
    fc.integer({ min: MAX_TERM + 1, max: MAX_TERM + 80 }).map((n) => 'q'.repeat(n)),
    fc.integer({ min: MAX_TERM, max: MAX_TERM + 80 }).map((n) => `${'q'.repeat(n)}z`),
  )
  const text = fc.array(piece, { maxLength: 6 }).map((ps) => ps.join(' '))
  const product = fc.record({
    name: text,
    description: text,
    status: fc.constantFrom('active', 'draft', 'archived'),
    categoryIds: fc.array(fc.constantFrom('cat-a', 'cat-b', 'cat-c'), { maxLength: 4 }),
    variants: fc.array(
      fc.record({ sku: text, name: text, priceMinor: fc.integer({ min: 1, max: 99_999 }) }),
      { maxLength: 3 },
    ),
  })

  it("AC-3: property: each product's record holds native's terms for it in native's order as _terms, its id, type, slug and category ids, and no other field", async () => {
    const config = algoliaConfig(fake.host)
    const adapter = await adapterOn(config)
    await fc.assert(
      fc.asyncProperty(fc.array(product, { minLength: 1, maxLength: 5 }), async (products) => {
        const token = randomUUID().slice(0, 8)
        const docs = products.map((p, i) => productDoc(`${token}-${i}`, p))
        const result = await adapter.index(docs)
        expect(result.indexed).toBe(docs.length)
        const byId = new Map(fake.records(config.indexName).map((r) => [r.objectID, r]))
        for (const doc of docs) {
          const record = byId.get(doc.id)
          expect(record, `the record for ${doc.id}`).toBeDefined()
          const { fields } = record as AlgoliaRecord & { fields: Record<string, unknown> }
          expect(record!['_terms'], doc.id).toBe(nativeTerms(doc).join(' '))
          expect([record!.objectID, record!['type'], fields['slug']]).toEqual([
            doc.id,
            doc.type,
            doc.fields['slug'],
          ])
          expect([...(record!['categoryIds'] as string[])].sort()).toEqual(
            [...new Set(doc.fields['categoryIds'] as string[])].sort(),
          )
          expect(Object.keys(record!).sort()).toEqual([
            '_terms',
            'categoryIds',
            'fields',
            'objectID',
            'type',
          ])
          expect(
            Object.keys(fields).filter(
              (k) => !['slug', 'name', 'status', 'categoryIds'].includes(k),
            ),
          ).toEqual([])
        }
      }),
      { numRuns: 30 },
    )
  }, 60_000)

  it('AC-3: a product whose record would pass 10 KB is indexed with the leading terms that fit, and a warning names it', async () => {
    const captured = capturingLogger()
    const config = algoliaConfig(fake.host)
    const adapter = await adapterOn(config, { logger: captured.logger })
    const id = `big-${randomUUID().slice(0, 8)}`
    const words = Array.from({ length: 2500 }, (_, i) => `w${i.toString(36).padStart(4, '0')}`)
    const doc: SearchDocument = productDoc(id, {
      name: 'Big Catalogue Entry',
      description: words.join(' '),
    })
    const all = nativeTerms(doc)
    // Precondition: every term in the record would not fit.
    expect(all.join(' ').length).toBeGreaterThan(RECORD_LIMIT_BYTES)

    const result = await adapter.index([doc])

    expect(result.indexed).toBe(1)
    const record = fake.records(config.indexName).find((r) => r.objectID === id)!
    const kept = String(record['_terms']).split(' ')
    expect(kept).toEqual(all.slice(0, kept.length))
    expect(bytes(record)).toBeLessThanOrEqual(RECORD_LIMIT_BYTES)
    // Only whole terms from the end, and no more than it had to: one more term would not fit.
    expect(bytes({ ...record, _terms: all.slice(0, kept.length + 1).join(' ') })).toBeGreaterThan(
      RECORD_LIMIT_BYTES,
    )
    expect(captured.warnings.filter((w) => w.includes(id)).length).toBeGreaterThanOrEqual(1)
  })
})

describe('AC-1: a query reaches Algolia as its capped terms', () => {
  it('AC-1: a query whose capped terms pass 512 bytes searches its leading terms that fit, and no query sent passes 512 bytes', async () => {
    const config = algoliaConfig(fake.host)
    const adapter = await adapterOn(config)
    // Precondition: the fake refuses a longer query, as Algolia does.
    const refused = await fetch(`${fake.host}/1/indexes/${config.indexName}/query`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': config.appId,
        'X-Algolia-API-Key': config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'x'.repeat(QUERY_LIMIT_BYTES + 1) }),
    })
    expect(refused.status).toBe(400)

    const token = `t${randomUUID().replace(/-/g, '').slice(0, 15)}`
    const [b, c, d] = ['b', 'c', 'd'].map((ch) => ch.repeat(300)) as [string, string, string]
    const first = productDoc(`${token}-1`, { name: `${token} ${b}` })
    const both = productDoc(`${token}-2`, { name: `${token} ${b} ${c} ${d}` })
    await adapter.index([first, both])
    const before = fake.requests.length

    // `${token} ${b}` is 317 bytes; one more 300-character term would make 618.
    const long = await adapter.search(`${token} ${b} ${c} ${d}`, { limit: 10 })
    const leading = await adapter.search(`${token} ${b}`, { limit: 10 })

    const ids = (r: SearchResult) => r.items.map((i: SearchDocument) => i.id).sort()
    expect(ids(long)).toEqual(ids(leading))
    expect(ids(leading)).toEqual([first.id, both.id].sort())
    expect(long.total).toBe(leading.total)
    const sent = fake.requests.slice(before).filter(isSearchRequest).flatMap(sentQueries)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...sent.map((q) => Buffer.byteLength(q, 'utf8')))).toBeLessThanOrEqual(
      QUERY_LIMIT_BYTES,
    )
  })
})

describe('AC-4: a slow or failing Algolia', () => {
  type Outcome = { error: unknown; ms: number }
  const outcome = async (call: () => Promise<unknown>): Promise<Outcome> => {
    const started = Date.now()
    try {
      await call()
      return { error: null, ms: Date.now() - started }
    } catch (error) {
      return { error, ms: Date.now() - started }
    }
  }

  it('AC-4: against an Algolia that never answers, a search and an index each reject with an AdapterError at the 5 s timeout, inside the contract bound of 6 s', async () => {
    const silent = await startSilentServer()
    try {
      const adapter = await adapterOn(algoliaConfig(silent.host), { initialize: false })
      const outcomes = await Promise.all([
        outcome(() => adapter.search('anything', { limit: 1 })),
        outcome(() => adapter.index([productDoc('hung-1', { name: 'Hung' })])),
      ])
      for (const o of outcomes) {
        expect(o.error).toBeInstanceOf(AdapterError)
        expect(o.ms).toBeGreaterThanOrEqual(4_500)
        expect(o.ms).toBeLessThan(6_000)
      }
    } finally {
      await silent.close()
    }
  }, 20_000)

  it("AC-4: property: an HTTP error from Algolia is an AdapterError naming its status and Algolia's message, and the API key is nowhere in it", async () => {
    const guarded = await startFakeAlgolia({ apiKey: 'the-right-key' })
    try {
      await fc.assert(
        fc.asyncProperty(fc.stringMatching(/^[a-f0-9]{32}$/), async (wrongKey) => {
          const config = algoliaConfig(guarded.host, { apiKey: wrongKey })
          const adapter = await adapterOn(config, { initialize: false })
          const refused = await outcome(() => adapter.search('anything'))
          const refusedWrite = await outcome(() =>
            adapter.index([productDoc('k-1', { name: 'K' })]),
          )
          const refusedInit = await outcome(() => adapter.initialize({ ...config }))
          for (const { error } of [refused, refusedWrite, refusedInit]) {
            expect(error).toBeInstanceOf(AdapterError)
            const e = error as AdapterError & { context?: unknown; cause?: unknown }
            expect(e.message).toContain('403')
            expect(e.message).toContain('Invalid Application-ID or API key')
            const everything = [
              e.message,
              e.stack ?? '',
              JSON.stringify(e.context ?? null),
              String(e.cause ?? ''),
              JSON.stringify(e),
            ].join('\n')
            expect(everything.includes(wrongKey), 'the key is in the error').toBe(false)
          }
        }),
        { numRuns: 10 },
      )

      // Another status, so the one named is Algolia's own: a search of an index that was never made.
      const unmade = algoliaConfig(guarded.host, { apiKey: 'the-right-key' })
      const missing = await outcome(async () =>
        (await adapterOn(unmade, { initialize: false })).search('anything'),
      )
      expect(missing.error).toBeInstanceOf(AdapterError)
      expect((missing.error as Error).message).toContain('404')
      expect((missing.error as Error).message).toContain('Index does not exist')

      // A key fetch refuses as a header: its refusal quotes the value, so it must reach neither an error nor a log.
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[a-f][a-f0-9]{7,31}$/),
          fc.constantFrom('\n', '\r\n', '\r', '\0'),
          fc.stringMatching(/^[A-Z]{4,12}$/),
          async (head, brk, tail) => {
            const badKey = `${head}${brk}${tail}`
            const config = algoliaConfig(guarded.host, { apiKey: badKey })
            const created = await outcome(() => adapterOn(config, { initialize: false }))
            expect(created.error).toBeInstanceOf(ConfigError)
            const captured = capturingLogger()
            // Past createAdapter's check, the transport path itself keeps the key out.
            const direct = createAlgoliaSearchAdapter({
              connection: config,
              logger: captured.logger,
            })
            const init = await outcome(() => direct.initialize({ ...config }))
            const searched = await outcome(() => direct.search('anything'))
            const retried = await outcome(() => direct.search('anything'))
            expect(init.error).toBeNull()
            expect(captured.warnings.length).toBeGreaterThanOrEqual(1)
            const errors = [created.error, searched.error, retried.error]
            for (const error of [searched.error, retried.error]) {
              expect(error).toBeInstanceOf(AdapterError)
              expect((error as AdapterError).code).toBe('adapter.algolia_unreachable')
            }
            const everything = [
              ...errors.flatMap((error) => {
                const e = error as Error & { context?: unknown; cause?: unknown }
                return [
                  e.message,
                  e.stack ?? '',
                  JSON.stringify(e.context ?? null),
                  String(e.cause ?? ''),
                  (e.cause as Error | undefined)?.stack ?? '',
                  JSON.stringify(e),
                ]
              }),
              ...captured.warnings,
              ...captured.warnings.map((w) => JSON.parse(w) as unknown).map(String),
            ].join('\n')
            expect(everything.includes(badKey), 'the key is in an error or a log').toBe(false)
            expect(
              everything.includes(JSON.stringify(badKey).slice(1, -1)),
              'the key, escaped, is in an error or a log',
            ).toBe(false)
            expect(everything.includes(head), 'the head of the key is in an error or a log').toBe(
              false,
            )
          },
        ),
        { numRuns: 10 },
      )
    } finally {
      await guarded.close()
    }
  }, 60_000)

  /** A server answering every request with `status` and Algolia's error body. */
  async function answering(status: number): Promise<{ host: string; close(): Promise<void> }> {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: `status ${status}`, status }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    return {
      host: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  it('AC-4: initialize against an Algolia answering 5xx or 429 resolves with a warning and the next call writes the settings; a 4xx refusal still rejects', async () => {
    for (const status of [500, 502, 503, 429]) {
      const down = await answering(status)
      try {
        const captured = capturingLogger()
        const config = algoliaConfig(down.host)
        const adapter = await adapterOn(config, { initialize: false, logger: captured.logger })
        const init = await outcome(() => adapter.initialize({ ...config }))
        expect(init.error, `initialize against ${status}`).toBeNull()
        expect(captured.warnings.length, `the warning for ${status}`).toBeGreaterThanOrEqual(1)
      } finally {
        await down.close()
      }
    }
    for (const status of [400, 401, 403, 404]) {
      const refusing = await answering(status)
      try {
        const config = algoliaConfig(refusing.host)
        const adapter = await adapterOn(config, { initialize: false })
        const init = await outcome(() => adapter.initialize({ ...config }))
        expect(init.error, `initialize against ${status}`).toBeInstanceOf(AdapterError)
        expect((init.error as Error).message).toContain(String(status))
      } finally {
        await refusing.close()
      }
    }

    // The fake fails the first settings write with a 5xx; the call after initialize writes them.
    const config = algoliaConfig(fake.host)
    let failed = 0
    fake.intercept(({ method, path }) => {
      if (method === 'PUT' && path.endsWith('/settings') && failed === 0) {
        failed++
        throw new Error('Algolia is busy')
      }
    })
    try {
      const adapter = await adapterOn(config, { initialize: false })
      const init = await outcome(() => adapter.initialize({ ...config }))
      expect(init.error).toBeNull()
      expect(fake.requests.some((r) => r.index === config.indexName && r.status === 500)).toBe(true)
      expect(fake.settings(config.indexName)?.['queryType']).toBeUndefined()
      const doc = productDoc(`late-${randomUUID().slice(0, 8)}`, { name: 'Lateboot Lantern' })
      await adapter.index([doc])
      const { paginationLimitedTo: _limit, ...applied } = fake.settings(config.indexName) ?? {}
      expect(applied).toEqual({
        searchableAttributes: ['_terms'],
        attributesForFaceting: ['categoryIds'],
        queryType: 'prefixAll',
        typoTolerance: false,
        ignorePlurals: false,
        removeStopWords: false,
        advancedSyntax: false,
      })
      const found = await adapter.search('latebo')
      expect(found.items.map((i) => i.id)).toEqual([doc.id])
    } finally {
      fake.intercept(null)
    }
  }, 30_000)
})
