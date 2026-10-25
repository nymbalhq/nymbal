import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSession, type AdminSession, type Answer } from '../audit-http.js'
import { readHistory, untilDelivered } from '../history.js'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Dialect, Kernel } from '../kernel.js'
import { eventRows, maxSeq, type EventRow } from '../outbox.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'

// The admin's variant price edit over HTTP, on one dialect: `PATCH /api/admin/products/:id` with the body the admin's
// product page sends (the whole snapshot, every variant with all its fields) or a caller's own list of variants. A
// price saved is what the admin read and the storefront read serve, and each real change is one
// product.variant_price_changed.v1 in the request's correlation, beside its one product.updated.v1. Rows are read
// from a second connection, events from the log.

export interface AdminVariantPriceSuiteOptions {
  /** A kernel on a database of its own, migrated to the newest migration. */
  open(): Promise<Kernel>
  propertyRuns: number
}

const PRICE_CHANGED = 'product.variant_price_changed.v1'
const UPDATED = 'product.updated.v1'

type Json = Record<string, unknown>

interface Prices {
  priceMinor: number
  compareAtPriceMinor: number | null
}

interface Store {
  k: Kernel
  served: ServedKernel
  admin: AdminSession
  raw: RawReader
}

interface Made {
  id: string
  slug: string
  variantIds: string[]
}

async function makeProduct(s: Store, variants: Prices[]): Promise<Made> {
  const tag = randomUUID().slice(0, 8)
  const created = await s.admin.send<{ id: string; slug: string; variants: Array<{ id: string }> }>(
    'POST',
    '/api/admin/products',
    {
      slug: `price-${tag}`,
      name: `Priced ${tag}`,
      description: 'Priced by the admin.',
      status: 'active',
      variants: variants.map((v, i) => ({
        sku: `PRICE-${i}-${tag}`,
        name: `Size ${i}`,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor,
        stock: 5 + i,
        options: [{ name: 'Size', value: `S${i}` }],
      })),
    },
  )
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const data = created.body.data!
  return { id: data.id, slug: data.slug, variantIds: data.variants.map((v) => v.id) }
}

/** `GET /api/admin/products/:id`'s data: the snapshot the admin's product page loads and edits. */
async function adminRead(s: Store, id: string): Promise<Json> {
  const res = await s.admin.send<Json>('GET', `/api/admin/products/${id}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

const variantsOf = (snapshot: Json): Json[] => snapshot['variants'] as Json[]

/** Each variant's prices by id, from a snapshot's variants. */
function pricesOf(variants: Json[]): Record<string, Prices> {
  return Object.fromEntries(
    variants.map((v) => [
      String(v['id']),
      {
        priceMinor: Number(v['priceMinor']),
        compareAtPriceMinor: (v['compareAtPriceMinor'] ?? null) as number | null,
      },
    ]),
  )
}

/** Each variant's price as `GET /api/products/:slug` serves it, once every event has reached the read side. */
async function servedPrices(s: Store, slug: string): Promise<Record<string, number>> {
  await untilDelivered(s.raw)
  const res = await fetch(new URL(`/api/products/${slug}`, s.served.baseUrl))
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    data: { variants: Array<{ id: string; priceMinor: number }> }
  }
  return Object.fromEntries(body.data.variants.map((v) => [v.id, v.priceMinor]))
}

const patch = (s: Store, id: string, body: unknown): Promise<Answer<Json>> =>
  s.admin.send<Json>('PATCH', `/api/admin/products/${id}`, body)

/** The events above `seq` in one correlation. */
async function correlated(
  s: Store,
  seq: number,
  correlationId: string | null,
): Promise<EventRow[]> {
  expect(correlationId, 'the PATCH echoes x-correlation-id').not.toBeNull()
  return (await eventRows(s.raw, 'seq > ?', [seq])).filter(
    (e) => e.envelope.correlationId === correlationId,
  )
}

const payloadsOf = (rows: EventRow[], type: string): Json[] =>
  rows
    .filter((e) => e.type === type)
    .map((e) => e.envelope.payload as Json)
    .sort((a, b) => String(a['variantId']).localeCompare(String(b['variantId'])))

/** What the product's variants' stock is in the table, by id. */
async function stocks(s: Store, ids: string[]): Promise<number[]> {
  return Promise.all(ids.map((id) => stockOf(s.raw, id)))
}

// ─── The model of one edit ─────────────────────────────────────────────────────────────────────────────────────────

/** One item a PATCH carries: `compare` undefined leaves the key out, null clears, a number sets. */
interface Item {
  at: number
  priceMinor: number
  compare: number | null | undefined
}

interface Edit {
  /** The admin's whole snapshot (every variant, unedited ones as loaded), or the listed items alone. */
  whole: boolean
  items: Item[]
}

const PRICES = [0, 900, 1000, 1500, 2500]
const arbItem = (variants: number): fc.Arbitrary<Item> =>
  fc.record({
    at: fc.integer({ min: 0, max: variants - 1 }),
    priceMinor: fc.constantFrom(...PRICES),
    compare: fc.option(fc.option(fc.constantFrom(...PRICES), { nil: null }), { nil: undefined }),
  })

/** Distinct variants per edit: the first item for an index wins. */
function distinct(items: Item[]): Item[] {
  const seen = new Set<number>()
  return items.filter((item) => !seen.has(item.at) && seen.add(item.at))
}

function itemBody(id: string, item: Item): Json {
  return {
    id,
    priceMinor: item.priceMinor,
    ...(item.compare !== undefined && { compareAtPriceMinor: item.compare }),
  }
}

/** The prices after an edit, and how many variants it really changed. */
function applied(
  before: Record<string, Prices>,
  ids: string[],
  items: Item[],
): { after: Record<string, Prices>; changed: string[] } {
  const after = structuredClone(before)
  const changed: string[] = []
  for (const item of items) {
    const id = ids[item.at]!
    const next: Prices = {
      priceMinor: item.priceMinor,
      compareAtPriceMinor:
        item.compare === undefined ? before[id]!.compareAtPriceMinor : item.compare,
    }
    if (
      next.priceMinor !== before[id]!.priceMinor ||
      next.compareAtPriceMinor !== before[id]!.compareAtPriceMinor
    ) {
      changed.push(id)
    }
    after[id] = next
  }
  return { after, changed }
}

// ─── The suite ────────────────────────────────────────────────────────────────────────────────────────────────────

export function adminVariantPriceSuite(
  dialect: Dialect,
  options: AdminVariantPriceSuiteOptions,
): void {
  describe(`the admin's variant price edit (${dialect})`, () => {
    let s: Store

    beforeAll(async () => {
      const k = await options.open()
      const served = await serveKernel(k)
      s = {
        k,
        served,
        admin: await adminSession(k, served.baseUrl),
        raw: openRaw(k.dialect, k.target),
      }
    }, 60_000)

    afterAll(async () => {
      await s?.raw.close()
      await s?.served.stop()
    })

    it('AC-1: the body the admin sends, with one price and one compare-at price changed and every stock changed, saves both prices in the response, the admin read and the storefront read, logs one price event per changed variant with the old and new prices and the store currency beside one product.updated.v1 in its correlation, moves no stock, and adds one History entry', async () => {
      const product = await makeProduct(s, [
        { priceMinor: 1500, compareAtPriceMinor: null },
        { priceMinor: 2000, compareAtPriceMinor: 2500 },
        { priceMinor: 3000, compareAtPriceMinor: 3500 },
      ])
      const [a, b, c] = product.variantIds as [string, string, string]
      const loaded = await adminRead(s, product.id)
      const stockBefore = await stocks(s, product.variantIds)
      await untilDelivered(s.raw)
      const historyBefore = (await readHistory(s.admin, 'product', product.id)).body.data!.entries
      const seq = await maxSeq(s.raw)

      const body = {
        ...loaded,
        description: 'Repriced by the admin.',
        variants: variantsOf(loaded).map((v) => ({
          ...v,
          stock: Number(v['stock']) + 7,
          ...(v['id'] === a && { priceMinor: 1200 }),
          ...(v['id'] === b && { compareAtPriceMinor: 2800 }),
        })),
      }
      const res = await patch(s, product.id, body)
      expect(res.status, JSON.stringify(res.body)).toBe(200)

      const expected = {
        [a]: { priceMinor: 1200, compareAtPriceMinor: null },
        [b]: { priceMinor: 2000, compareAtPriceMinor: 2800 },
        [c]: { priceMinor: 3000, compareAtPriceMinor: 3500 },
      }
      expect(pricesOf(variantsOf(res.body.data!)), 'the PATCH answer').toEqual(expected)
      expect(pricesOf(variantsOf(await adminRead(s, product.id))), 'the admin read').toEqual(
        expected,
      )
      expect(await servedPrices(s, product.slug), 'the storefront read').toEqual(
        Object.fromEntries(Object.entries(expected).map(([id, p]) => [id, p.priceMinor])),
      )

      const events = await correlated(s, seq, res.correlationId)
      const currency = s.k.config.store.currency
      expect(payloadsOf(events, PRICE_CHANGED)).toEqual(
        [
          {
            productId: product.id,
            variantId: a,
            previousPriceMinor: 1500,
            priceMinor: 1200,
            previousCompareAtPriceMinor: null,
            compareAtPriceMinor: null,
            currency,
          },
          {
            productId: product.id,
            variantId: b,
            previousPriceMinor: 2000,
            priceMinor: 2000,
            previousCompareAtPriceMinor: 2500,
            compareAtPriceMinor: 2800,
            currency,
          },
        ].sort((x, y) => x.variantId.localeCompare(y.variantId)),
      )
      expect(
        events.filter((e) => e.type === UPDATED).length,
        'product.updated.v1 in the correlation',
      ).toBe(1)
      expect(events.filter((e) => e.type.startsWith('inventory.')).map((e) => e.type)).toEqual([])
      expect(await stocks(s, product.variantIds), 'stock moves only through inventory').toEqual(
        stockBefore,
      )

      await untilDelivered(s.raw)
      const historyAfter = (await readHistory(s.admin, 'product', product.id)).body.data!.entries
      const added = historyAfter.filter((e) => !historyBefore.some((old) => old.seq === e.seq))
      expect(added.map((e) => [e.type, e.correlationId])).toEqual([[UPDATED, res.correlationId]])
    })

    it('AC-1: an item without compareAtPriceMinor keeps the stored compare-at price and, at the same priceMinor, logs nothing; null clears it and logs one event; with a new priceMinor the event carries the kept compare-at price', async () => {
      const product = await makeProduct(s, [
        { priceMinor: 1000, compareAtPriceMinor: 1400 },
        { priceMinor: 1000, compareAtPriceMinor: 1400 },
        { priceMinor: 1000, compareAtPriceMinor: 1400 },
      ])
      const [kept, cleared, repriced] = product.variantIds as [string, string, string]
      const seq = await maxSeq(s.raw)

      const res = await patch(s, product.id, {
        variants: [
          { id: kept, priceMinor: 1000 },
          { id: cleared, priceMinor: 1000, compareAtPriceMinor: null },
          { id: repriced, priceMinor: 800 },
        ],
      })
      expect(res.status, JSON.stringify(res.body)).toBe(200)

      expect(pricesOf(variantsOf(await adminRead(s, product.id)))).toEqual({
        [kept]: { priceMinor: 1000, compareAtPriceMinor: 1400 },
        [cleared]: { priceMinor: 1000, compareAtPriceMinor: null },
        [repriced]: { priceMinor: 800, compareAtPriceMinor: 1400 },
      })
      const events = await correlated(s, seq, res.correlationId)
      expect(
        payloadsOf(events, PRICE_CHANGED).map((p) => [
          p['variantId'],
          p['previousCompareAtPriceMinor'],
          p['compareAtPriceMinor'],
          p['previousPriceMinor'],
          p['priceMinor'],
        ]),
      ).toEqual(
        [
          [cleared, 1400, null, 1000, 1000],
          [repriced, 1400, 1400, 1000, 800],
        ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      )
    })

    it('AC-1: a variant id that is not this product’s answers 400 product.variant_unknown naming the id, and the product, the other product and the log are unchanged', async () => {
      const product = await makeProduct(s, [{ priceMinor: 1500, compareAtPriceMinor: null }])
      const other = await makeProduct(s, [{ priceMinor: 4000, compareAtPriceMinor: null }])
      const before = await adminRead(s, product.id)
      const otherBefore = await adminRead(s, other.id)

      for (const foreign of [other.variantIds[0]!, randomUUID()]) {
        const seq = await maxSeq(s.raw)
        const res = await patch(s, product.id, {
          name: `Renamed ${foreign}`,
          variants: [
            { id: product.variantIds[0]!, priceMinor: 1100 },
            { id: foreign, priceMinor: 100 },
          ],
        })
        expect([res.status, res.body.error?.code], JSON.stringify(res.body)).toEqual([
          400,
          'product.variant_unknown',
        ])
        expect(JSON.stringify(res.body.error), 'the refusal names the id').toContain(foreign)
        expect(await adminRead(s, product.id), 'the product').toEqual(before)
        expect(await adminRead(s, other.id), 'the other product').toEqual(otherBefore)
        expect((await eventRows(s.raw, 'seq > ?', [seq])).map((e) => e.type)).toEqual([])
      }
    })

    it('AC-1: a negative priceMinor or compareAtPriceMinor answers 400 and changes nothing', async () => {
      const product = await makeProduct(s, [{ priceMinor: 1500, compareAtPriceMinor: 1800 }])
      const id = product.variantIds[0]!
      const before = await adminRead(s, product.id)

      for (const item of [
        { id, priceMinor: -1 },
        { id, priceMinor: 1200, compareAtPriceMinor: -500 },
      ]) {
        const seq = await maxSeq(s.raw)
        const res = await patch(s, product.id, { name: 'Refused', variants: [item] })
        expect(res.status, JSON.stringify(item)).toBe(400)
        expect(await adminRead(s, product.id)).toEqual(before)
        expect((await eventRows(s.raw, 'seq > ?', [seq])).map((e) => e.type)).toEqual([])
      }
    })

    it('AC-1: property: over random sequences of edits (the whole snapshot or some variants, prices up, down or equal, compare-at prices omitted, cleared or set), each save logs one price event per variant it really changed and one product.updated.v1 in its correlation, a variant left out keeps its prices, and the admin and storefront reads serve the last saved prices', async () => {
      const VARIANTS = 3
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              whole: fc.boolean(),
              items: fc.array(arbItem(VARIANTS), { minLength: 1, maxLength: VARIANTS }),
            }),
            { minLength: 1, maxLength: 4 },
          ),
          async (edits: Edit[]) => {
            const product = await makeProduct(
              s,
              Array.from({ length: VARIANTS }, () => ({
                priceMinor: 1000,
                compareAtPriceMinor: null,
              })),
            )
            const ids = product.variantIds
            const start = await maxSeq(s.raw)
            let model = pricesOf(variantsOf(await adminRead(s, product.id)))
            let realChanges = 0

            for (const edit of edits) {
              const items = distinct(edit.items)
              const label = JSON.stringify(edit)
              const loaded = await adminRead(s, product.id)
              const listed = new Map(items.map((item) => [ids[item.at]!, item]))
              const body = edit.whole
                ? {
                    ...loaded,
                    variants: variantsOf(loaded).map((v) => {
                      const item = listed.get(String(v['id']))
                      if (item === undefined) return v
                      const { compareAtPriceMinor: _, ...rest } = v
                      return { ...rest, ...itemBody(String(v['id']), item) }
                    }),
                  }
                : { variants: items.map((item) => itemBody(ids[item.at]!, item)) }
              const seq = await maxSeq(s.raw)
              const res = await patch(s, product.id, body)
              expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(200)

              const { after, changed } = applied(model, ids, items)
              const events = await correlated(s, seq, res.correlationId)
              expect(
                payloadsOf(events, PRICE_CHANGED).map((p) => p['variantId']),
                `${label}: the variants a price event names`,
              ).toEqual([...changed].sort())
              for (const p of payloadsOf(events, PRICE_CHANGED)) {
                const id = String(p['variantId'])
                expect(
                  [
                    p['previousPriceMinor'],
                    p['priceMinor'],
                    p['previousCompareAtPriceMinor'],
                    p['compareAtPriceMinor'],
                  ],
                  `${label}: ${id}`,
                ).toEqual([
                  model[id]!.priceMinor,
                  after[id]!.priceMinor,
                  model[id]!.compareAtPriceMinor,
                  after[id]!.compareAtPriceMinor,
                ])
              }
              expect(events.filter((e) => e.type === UPDATED).length, label).toBe(1)
              expect(pricesOf(variantsOf(await adminRead(s, product.id))), label).toEqual(after)
              model = after
              realChanges += changed.length
            }

            const logged = (
              await eventRows(s.raw, 'seq > ? AND type = ?', [start, PRICE_CHANGED])
            ).filter((e) => (e.envelope.payload as { productId?: string }).productId === product.id)
            expect(logged.length, 'price events over the sequence').toBe(realChanges)
            expect(await servedPrices(s, product.slug)).toEqual(
              Object.fromEntries(Object.entries(model).map(([id, p]) => [id, p.priceMinor])),
            )
          },
        ),
        {
          numRuns: options.propertyRuns,
          examples: [
            [
              [
                { whole: true, items: [{ at: 0, priceMinor: 900, compare: undefined }] },
                { whole: false, items: [{ at: 1, priceMinor: 1000, compare: undefined }] },
                { whole: false, items: [{ at: 2, priceMinor: 1000, compare: 1500 }] },
                { whole: true, items: [{ at: 2, priceMinor: 1000, compare: null }] },
              ],
            ],
          ],
        },
      )
    }, 300_000)
  })
}
