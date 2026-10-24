import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { SearchAdapter, SearchResult } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'
import {
  matchesQuery,
  searchTerms,
  tierOf,
  toSearchDocument,
  type ContractProduct,
} from './search-oracle.js'

// The search contract. The cases are index-agnostic: the index may be shared across cases and runs and no runner
// truncates it. Every generated product carries a run token term in its name and every query puts the token first, so
// the AND of the query's terms scopes it to the run, the oracle is over the run's products, and the run removes them
// when it ends.

export interface SearchContractOptions extends ContractOptions<SearchAdapter> {
  /** The adapter ranks by tiers (every term in the name, then every term in name, SKU or variant name), then score,
   *  then id. Native does; a vendor's need not, so the ranking case runs only when the runner says so. */
  ranking?: boolean
  /** The adapter reports `facet` and counts `facet('categoryIds', {query, filters})` within the query's matches. */
  facets?: boolean
  /** This adapter's cursor for an offset, valid or not (it encodes; only search validates), so the malformed-cursor
   *  case can build a negative and a non-integer cursor. Without it only the undecodable and the stale cursor run. */
  cursorAt?: (offset: number) => string
  /** fast-check runs per property (default 25). */
  numRuns?: number
}

// --- Generators ---------------------------------------------------------------------------------------------------

/** One length, a leading letter no generated word uses: no token is a prefix of another or of a generated word. */
function runToken(): string {
  return `t${randomUUID().replace(/-/g, '').slice(0, 15)}`
}

/** Words over a small alphabet, so they share prefixes and collide often. */
const word = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'd', '1', '2'),
  minLength: 1,
  maxLength: 3,
})
const words = (max: number) => fc.array(word, { maxLength: max }).map((ws) => ws.join(' '))

interface GenProduct {
  name: string
  description: string
  // priceMinor's digits overlap the words' digits: a search over every field would match on a price.
  variants: Array<{ sku: string; name: string; priceMinor: number }>
  categories: number[]
}

const CATEGORIES = 3

const genProduct: fc.Arbitrary<GenProduct> = fc.record({
  name: words(3),
  description: words(6),
  variants: fc.array(
    fc.record({ sku: word, name: words(2), priceMinor: fc.integer({ min: 1, max: 2222 }) }),
    { maxLength: 3 },
  ),
  categories: fc.subarray([0, 1, 2]),
})

/** The run's category ids: one term each, `c0…`, `c1…`; a search over every field would match `c1` on one. */
function runCategories(token: string): string[] {
  return Array.from({ length: CATEGORIES }, (_, k) => `c${k}${token.slice(1)}`)
}

function materialise(token: string, gen: GenProduct, i: number, cats: string[]): ContractProduct {
  return {
    id: `${token}-${i}`,
    name: gen.name === '' ? token : `${token} ${gen.name}`,
    description: gen.description,
    variants: gen.variants,
    categoryIds: gen.categories.map((k) => cats[k]!),
  }
}

// --- Walking -------------------------------------------------------------------------------------------------------

async function walk(
  adapter: SearchAdapter,
  query: string,
  limit: number,
  expectedMatches: number,
  filters?: Record<string, unknown>,
): Promise<SearchResult[]> {
  // Room for every page an exact walk needs, and two more: a walk past it is one whose cursor does not advance.
  const maxPages = Math.ceil(expectedMatches / limit) + 2
  const pages: SearchResult[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await adapter.search(query, {
      limit,
      ...(cursor !== undefined && { cursor }),
      ...(filters !== undefined && { filters }),
    })
    pages.push(page)
    // Fails at the first repeat rather than after the whole walk: a cursor read as page 1 then costs two pages, not
    // every page, on each of the runs fast-check shrinks through.
    const again = page.items.map((item) => item.id).filter((id) => seen.has(id))
    expect(again, `the walk for "${query}": an id came back on page ${pages.length}`).toEqual([])
    for (const item of page.items) seen.add(item.id)
    if (page.nextCursor === null) return pages
    expect(
      pages.length,
      `the walk for "${query}" did not end within ${maxPages} pages`,
    ).toBeLessThan(maxPages)
    cursor = page.nextCursor
  }
}

const idsOf = (pages: SearchResult[]) => pages.flatMap((p) => p.items.map((item) => item.id))

/** One walk against the oracle's match set: each match once, an exact total, no page past limit, a last page. */
function expectExactWalk(
  pages: SearchResult[],
  expected: string[],
  limit: number,
  label: string,
): void {
  const ids = idsOf(pages)
  expect(new Set(ids).size, `${label}: an id came back on two pages`).toBe(ids.length)
  expect([...ids].sort(), `${label}: the walk's union is not the oracle's match set`).toEqual(
    [...expected].sort(),
  )
  for (const [i, page] of pages.entries()) {
    expect(page.total, `${label}: total on page ${i + 1}`).toBe(expected.length)
    expect(page.items.length, `${label}: page ${i + 1} exceeds limit`).toBeLessThanOrEqual(limit)
    expect(
      page.nextCursor === null,
      `${label}: nextCursor is null on page ${i + 1} of ${pages.length}`,
    ).toBe(i === pages.length - 1)
    // With an exact total the page that completes the walk is the last: only a walk with no match has an empty page.
    if (expected.length > 0)
      expect(page.items.length, `${label}: page ${i + 1} is empty`).toBeGreaterThan(0)
  }
}

const SLOW = 180_000

export function runSearchContract(
  name: string,
  build: Build<SearchAdapter>,
  options: SearchContractOptions = {},
): void {
  const numRuns = options.numRuns ?? 25

  describe(`SearchAdapter contract: ${name}`, () => {
    it(
      'index returns count of indexed documents',
      async () => {
        const adapter = await build()
        const result = await adapter.index([
          { id: 'doc-1', type: 'product', fields: { name: 'Widget' } },
          { id: 'doc-2', type: 'product', fields: { name: 'Gadget' } },
        ])
        expect(result.indexed).toBe(2)
      },
      CASE_MS,
    )

    it(
      'search returns indexed documents',
      async () => {
        const adapter = await build()
        await adapter.index([
          { id: 'search-doc-1', type: 'product', fields: { name: 'Searchable Item' } },
        ])
        const result = await adapter.search('Searchable')
        expect(result.items.length).toBeGreaterThanOrEqual(1)
        expect(result.total).toBeGreaterThanOrEqual(1)
      },
      CASE_MS,
    )

    it(
      'remove deletes documents from index',
      async () => {
        const adapter = await build()
        const tag = `remove-${randomUUID()}`
        await adapter.index([{ id: tag, type: 'product', fields: { name: 'To Remove' } }])
        await adapter.remove([tag])
        const result = await adapter.search('To Remove')
        expect(result.items.find((i) => i.id === tag)).toBeUndefined()
      },
      CASE_MS,
    )

    it(
      'facet returns values for a field',
      async () => {
        const adapter = await build()
        await adapter.index([
          { id: 'facet-doc-1', type: 'product', fields: { category: 'shirts' } },
          { id: 'facet-doc-2', type: 'product', fields: { category: 'trousers' } },
          { id: 'facet-doc-3', type: 'product', fields: { category: 'shirts' } },
        ])
        const facet = await adapter.facet('category')
        expect(typeof facet.field).toBe('string')
        expect(typeof facet.label).toBe('string')
        expect(Array.isArray(facet.values)).toBe(true)
        if (facet.values.length > 0) {
          expect(typeof facet.values[0]!.value).toBe('string')
        }
      },
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'search()', (adapter) =>
      adapter.search('contract', { limit: 1 }),
    )

    describe('pages, ranking, facets and hostile input', () => {
      // Kills: a cursor that is ignored (page 1 again, or no next page), a total that counts the page or a capped
      // prefix, a filter that is skipped or only applied with a query, a removed doc that lingers, a re-index that
      // appends instead of replacing, and a tokeniser other than the oracle's (a price or category id searched,
      // punctuation kept, a prefix not matched).
      it(
        'over generated catalogues and page sizes, the cursor walk yields each oracle match exactly once, total is exact on every page, nextCursor is null exactly on the last page and no page exceeds limit, with and without a category filter, after removals and re-indexes',
        async () => {
          const adapter = await build()
          await fc.assert(
            fc.asyncProperty(
              // The page size first: fast-check shrinks the arguments in order, so a failing walk shrinks its limit
              // before its catalogue, and the catalogue's products are shrunk once there are few of them.
              fc.integer({ min: 1, max: 40 }),
              fc.array(fc.record({ first: genProduct, second: fc.option(genProduct) }), {
                maxLength: 300,
                size: 'large',
              }),
              fc.array(word, { maxLength: 2 }),
              fc.integer({ min: 0, max: CATEGORIES - 1 }),
              fc.func(fc.boolean()),
              async (limit, catalogue, queryWords, filterCategory, removeIt) => {
                const token = runToken()
                const cats = runCategories(token)
                const first = catalogue.map((c, i) => materialise(token, c.first, i, cats))
                try {
                  const indexed = await adapter.index(first.map(toSearchDocument))
                  expect(indexed.indexed).toBe(first.length)
                  // Re-indexes: the second version replaces the first.
                  const current = catalogue.map((c, i) =>
                    c.second === null ? first[i]! : materialise(token, c.second, i, cats),
                  )
                  const rewritten = current.filter((_, i) => catalogue[i]!.second !== null)
                  if (rewritten.length > 0) await adapter.index(rewritten.map(toSearchDocument))
                  // Removals.
                  const removed = current.filter((p) => removeIt(p.id))
                  if (removed.length > 0) await adapter.remove(removed.map((p) => p.id))
                  const gone = new Set(removed.map((p) => p.id))
                  const live = current.filter((p) => !gone.has(p.id))

                  const query = [token, ...queryWords].join(' ')
                  const matches = live.filter((p) => matchesQuery(p, query))
                  const all = await walk(adapter, query, limit, matches.length)
                  expectExactWalk(
                    all,
                    matches.map((p) => p.id),
                    limit,
                    `"${query}" limit ${limit}`,
                  )

                  const category = cats[filterCategory]!
                  const inCategory = matches.filter((p) => p.categoryIds.includes(category))
                  const filtered = await walk(adapter, query, limit, inCategory.length, {
                    categoryIds: category,
                  })
                  expectExactWalk(
                    filtered,
                    inCategory.map((p) => p.id),
                    limit,
                    `"${query}" in ${category} limit ${limit}`,
                  )

                  // No removed id on any page of either walk.
                  const shown = [...idsOf(all), ...idsOf(filtered)]
                  expect(
                    shown.filter((id) => gone.has(id)),
                    'a removed id came back',
                  ).toEqual([])
                } finally {
                  await adapter.remove(first.map((p) => p.id))
                }
              },
            ),
            { numRuns },
          )
        },
        SLOW,
      )

      if (options.ranking) {
        // Kills: an order by engine score alone (ts_rank_cd lets a description repeating the term outrank a name
        // hit), by insertion order, or one that differs between two walks of the same query.
        it(
          'for any query, every all-terms-in-name match ranks above every other match and every name/SKU/variant-name match above every description-only match, however often the description repeats the term, and the same query walks in the same order twice',
          async () => {
            const adapter = await build()
            const placed = fc.record({
              base: genProduct,
              inName: fc.boolean(),
              inSku: fc.boolean(),
              inVariant: fc.boolean(),
              descriptionRepeats: fc.integer({ min: 0, max: 10 }),
            })
            await fc.assert(
              fc.asyncProperty(
                fc.array(placed, { minLength: 1, maxLength: 60 }),
                word,
                fc.option(word),
                fc.integer({ min: 1, max: 30 }),
                fc.integer({ min: 1, max: 30 }),
                async (catalogue, term, second, limitA, limitB) => {
                  const token = runToken()
                  const cats = runCategories(token)
                  const products = catalogue.map((c, i): ContractProduct => {
                    const p = materialise(token, c.base, i, cats)
                    const variants =
                      p.variants.length > 0
                        ? [...p.variants]
                        : [{ sku: 'zz', name: '', priceMinor: 1 }]
                    if (c.inSku) variants[0] = { ...variants[0]!, sku: `${term}9` }
                    if (c.inVariant)
                      variants[0] = { ...variants[0]!, name: `${variants[0]!.name} ${term}` }
                    return {
                      ...p,
                      name: c.inName ? `${p.name} ${term}` : p.name,
                      description: `${p.description}${` ${term}`.repeat(c.descriptionRepeats)}`,
                      variants,
                    }
                  })
                  try {
                    await adapter.index(products.map(toSearchDocument))
                    const query = [token, term, ...(second === null ? [] : [second])].join(' ')
                    const byId = new Map(products.map((p) => [p.id, p]))
                    const matches = products.filter((p) => matchesQuery(p, query))

                    const order = idsOf(await walk(adapter, query, limitA, matches.length))
                    expect([...order].sort(), 'the walk is not the match set').toEqual(
                      matches.map((p) => p.id).sort(),
                    )
                    const tiers = order.map((id) => tierOf(byId.get(id)!, query))
                    for (let i = 1; i < tiers.length; i++) {
                      expect(
                        tiers[i - 1],
                        `"${query}": ${order[i - 1]} (tier ${tiers[i - 1]}) ranked above ${order[i]} (tier ${tiers[i]})`,
                      ).toBeGreaterThanOrEqual(tiers[i]!)
                    }

                    const again = idsOf(await walk(adapter, query, limitB, matches.length))
                    expect(again, `"${query}" walked at limit ${limitA}, then ${limitB}`).toEqual(
                      order,
                    )
                  } finally {
                    await adapter.remove(products.map((p) => p.id))
                  }
                },
              ),
              { numRuns },
            )
          },
          SLOW,
        )
      }

      if (options.facets) {
        // Kills: a facet that ignores the query or the filters, counts a capped prefix, or lists a category with
        // no match.
        it(
          "facet('categoryIds', {query, filters}) counts, per category id, exactly the oracle's matches in that category under the filters, lists no category without one, and orders by count descending, then value",
          async () => {
            const adapter = await build()
            expect(adapter.capabilities()).toContain('facet')
            await fc.assert(
              fc.asyncProperty(
                fc.array(genProduct, { maxLength: 150, size: 'medium' }),
                fc.array(word, { maxLength: 2 }),
                fc.option(fc.integer({ min: 0, max: CATEGORIES - 1 })),
                async (catalogue, queryWords, filterCategory) => {
                  const token = runToken()
                  const cats = runCategories(token)
                  const products = catalogue.map((g, i) => materialise(token, g, i, cats))
                  try {
                    await adapter.index(products.map(toSearchDocument))
                    const query = [token, ...queryWords].join(' ')
                    const filter = filterCategory === null ? undefined : cats[filterCategory]!
                    const matches = products.filter(
                      (p) =>
                        matchesQuery(p, query) &&
                        (filter === undefined || p.categoryIds.includes(filter)),
                    )
                    const expected = new Map<string, number>()
                    for (const p of matches)
                      for (const c of p.categoryIds) expected.set(c, (expected.get(c) ?? 0) + 1)

                    const facet = await adapter.facet('categoryIds', {
                      query,
                      ...(filter !== undefined && { filters: { categoryIds: filter } }),
                    })
                    const label = `facet for "${query}"${filter === undefined ? '' : ` in ${filter}`}`
                    expect(
                      Object.fromEntries(facet.values.map((v) => [v.value, v.count])),
                      label,
                    ).toEqual(Object.fromEntries(expected))
                    const ordered = [...expected.entries()]
                      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
                      .map(([value]) => value)
                    expect(
                      facet.values.map((v) => v.value),
                      `${label}: order`,
                    ).toEqual(ordered)
                  } finally {
                    await adapter.remove(products.map((p) => p.id))
                  }
                },
              ),
              { numRuns },
            )
          },
          SLOW,
        )
      }

      // Kills: raw input reaching FTS MATCH or to_tsquery (a syntax error, or an operator that changes the match),
      // a tokeniser on either side other than the oracle's (case, punctuation, non-ASCII), an empty query that returns
      // everything, and a malformed cursor read as page 1 or a stale one that errors.
      describe('hostile input', () => {
        const operator = fc.constantFrom(
          '"',
          '*',
          'NEAR',
          'NEAR(',
          ':',
          '&',
          '|',
          '!',
          '(',
          ')',
          '-',
          '^',
          'AND',
          'OR',
          'NOT',
          "'",
          '\\',
          '{',
          '}',
          '<->',
          ':*',
          '+',
          '%',
          '_',
          ';',
          '\u0000',
        )
        const fragment = fc.oneof(
          fc.string({ unit: 'binary', maxLength: 6 }),
          operator,
          word,
          word.map((w) => w.toUpperCase()),
        )
        // Fragments glued together, so an operator sits against a word as it would in a typed query.
        const hostile = fc.array(fragment, { maxLength: 6 }).map((fs) => fs.join(''))
        const longTerm = 'a'.repeat(2047)
        const plain: GenProduct = { name: 'a b', description: 'c', variants: [], categories: [0] }

        it(
          "any string after the run token, full unicode and FTS operators included, never throws and returns exactly the oracle's matches for the query's normalised terms",
          async () => {
            const adapter = await build()
            await fc.assert(
              fc.asyncProperty(
                fc.array(genProduct, { maxLength: 40 }),
                hostile,
                async (catalogue, raw) => {
                  const token = runToken()
                  const cats = runCategories(token)
                  const products = catalogue.map((g, i) => materialise(token, g, i, cats))
                  try {
                    await adapter.index(products.map(toSearchDocument))
                    const query = `${token} ${raw}`
                    const expected = products.filter((p) => matchesQuery(p, query)).map((p) => p.id)
                    const result = await adapter.search(query, { limit: 100 })
                    expect(result.items.map((d) => d.id).sort(), JSON.stringify(query)).toEqual(
                      expected.sort(),
                    )
                    expect(result.total, JSON.stringify(query)).toBe(expected.length)
                  } finally {
                    await adapter.remove(products.map((p) => p.id))
                  }
                },
              ),
              {
                numRuns: numRuns * 2,
                // A term one byte past Postgres's longest lexeme (2046 bytes; terms are ASCII, so bytes are
                // characters): in the query, in a description, and in both.
                examples: [
                  [[plain], longTerm],
                  [[{ ...plain, description: `c ${longTerm}` }], ''],
                  [[{ ...plain, description: longTerm }], longTerm],
                ],
              },
            )
          },
          SLOW,
        )

        it(
          'input with no terms returns no items, total 0 and no next page, over an index that holds products',
          async () => {
            const adapter = await build()
            const token = runToken()
            const products: ContractProduct[] = Array.from({ length: 5 }, (_, i) => ({
              id: `${token}-${i}`,
              name: `${token} a b`,
              description: 'c d',
              variants: [{ sku: 'a1', name: 'b', priceMinor: 100 }],
              categoryIds: [],
            }))
            await adapter.index(products.map(toSearchDocument))
            try {
              const termless = fc
                .array(
                  fc.oneof(
                    operator,
                    fc.string({ unit: 'binary', maxLength: 4 }),
                    fc.constantFrom(' ', '\t', '\n'),
                  ),
                  { maxLength: 6 },
                )
                .map((fs) => fs.join(''))
                .filter((s) => searchTerms(s).length === 0)
              await fc.assert(
                fc.asyncProperty(termless, async (raw) => {
                  const result = await adapter.search(raw, { limit: 20 })
                  expect(result.items.length, JSON.stringify(raw)).toBe(0)
                  expect(result.total, JSON.stringify(raw)).toBe(0)
                  expect(result.nextCursor, JSON.stringify(raw)).toBeNull()
                }),
                {
                  numRuns: numRuns * 2,
                  examples: [[''], [' '], ['   '], ['*'], ['"'], ['-'], ['é']],
                },
              )
            } finally {
              await adapter.remove(products.map((p) => p.id))
            }
          },
          SLOW,
        )

        it(
          'a malformed cursor (undecodable, negative, non-integer) rejects, and a cursor at or past total, as after a removal between two pages, is an empty page with nextCursor null',
          async () => {
            const adapter = await build()
            const token = runToken()
            const products: ContractProduct[] = Array.from({ length: 6 }, (_, i) => ({
              id: `${token}-${i}`,
              name: `${token} cursor ${i}`,
              description: '',
              variants: [],
              categoryIds: [],
            }))
            await adapter.index(products.map(toSearchDocument))
            try {
              // A page-2 cursor taken while all six match, used after four are removed: its offset is past total.
              const first = await adapter.search(token, { limit: 4 })
              expect(first.total).toBe(products.length)
              expect(first.nextCursor, 'six matches at limit 4 have a second page').not.toBeNull()

              for (const cursor of ['not a cursor', '%%%', '!!']) {
                await expect(
                  adapter.search(token, { limit: 2, cursor }),
                  `cursor ${cursor}`,
                ).rejects.toThrow()
              }
              if (options.cursorAt !== undefined) {
                for (const offset of [-1, -20, 1.5, 0.25]) {
                  await expect(
                    adapter.search(token, { limit: 2, cursor: options.cursorAt(offset) }),
                    `cursor at offset ${offset}`,
                  ).rejects.toThrow()
                }
              }

              const kept = products.slice(0, 2)
              await adapter.remove(products.slice(2).map((p) => p.id))
              const stale = await adapter.search(token, { limit: 4, cursor: first.nextCursor! })
              expect(stale.items.length).toBe(0)
              expect(stale.nextCursor).toBeNull()
              expect(stale.total).toBe(kept.length)

              if (options.cursorAt !== undefined) {
                for (const offset of [kept.length, kept.length + 7]) {
                  const past = await adapter.search(token, {
                    limit: 4,
                    cursor: options.cursorAt(offset),
                  })
                  expect(past.items.length, `offset ${offset}`).toBe(0)
                  expect(past.nextCursor, `offset ${offset}`).toBeNull()
                  expect(past.total, `offset ${offset}`).toBe(kept.length)
                }
              }
            } finally {
              await adapter.remove(products.map((p) => p.id))
            }
          },
          SLOW,
        )
      })
    })
  })
}
