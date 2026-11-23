import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSession, type AdminSession, type Answer } from '../audit-http.js'
import { pastMillisecond } from '../history.js'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Dialect, Kernel } from '../kernel.js'
import { eventRows, maxSeq, type EventRow } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'

// A product's brand and its variants' GTINs through the admin API, on one dialect: what `POST` and `PATCH
// /api/admin/products` save is what `GET /api/admin/products/:id` answers, a GTIN rides on a variants entry beside its
// prices (omitted it keeps the stored one, null or '' clears it) and a GTIN change is carried by the request's one
// product.updated.v1, never by a price event. Events are read from the log on a second connection.

export interface AdminBrandGtinSuiteOptions {
  /** A kernel on a database of its own, migrated to the newest migration. */
  open(): Promise<Kernel>
}

const PRICE_CHANGED = 'product.variant_price_changed.v1'
const UPDATED = 'product.updated.v1'
const GTIN_A = '4006381333931'
const GTIN_B = '036000291452'

type Json = Record<string, unknown>

interface Store {
  served: ServedKernel
  admin: AdminSession
  raw: RawReader
}

const variantsOf = (snapshot: Json): Json[] => snapshot['variants'] as Json[]

async function adminRead(s: Store, id: string): Promise<Json> {
  const res = await s.admin.send<Json>('GET', `/api/admin/products/${id}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

const patch = (s: Store, id: string, body: unknown): Promise<Answer<Json>> =>
  s.admin.send<Json>('PATCH', `/api/admin/products/${id}`, body)

/** The events above `seq` in one request's correlation. */
async function correlated(s: Store, seq: number, answer: Answer<Json>): Promise<EventRow[]> {
  expect(answer.correlationId, 'the PATCH echoes x-correlation-id').not.toBeNull()
  return (await eventRows(s.raw, 'seq > ?', [seq])).filter(
    (e) => e.envelope.correlationId === answer.correlationId,
  )
}

/** Each variant's price, GTIN and updatedAt by id, from a snapshot. */
function identified(
  snapshot: Json,
): Record<string, { priceMinor: number; gtin: unknown; updatedAt: string }> {
  return Object.fromEntries(
    variantsOf(snapshot).map((v) => [
      String(v['id']),
      { priceMinor: Number(v['priceMinor']), gtin: v['gtin'], updatedAt: String(v['updatedAt']) },
    ]),
  )
}

export function adminBrandGtinSuite(dialect: Dialect, options: AdminBrandGtinSuiteOptions): void {
  describe(`a product's brand and its variants' GTINs through the admin API (${dialect})`, () => {
    let s: Store

    beforeAll(async () => {
      const k = await options.open()
      const served = await serveKernel(k)
      s = {
        served,
        admin: await adminSession(k, served.baseUrl),
        raw: openRaw(k.dialect, k.target),
      }
    }, 60_000)

    afterAll(async () => {
      await s?.raw.close()
      await s?.served.stop()
    })

    it("AC-2: a product created with a brand and a variant GTIN answers both on the admin read; brand alone changes the brand and no variant; a repeated price with a new GTIN sets it, moves only that variant's updatedAt and logs one product.updated.v1 carrying it and no price event; an entry without gtin keeps it; null and '' clear it; a brand with surrounding spaces is stored trimmed", async () => {
      const tag = randomUUID().slice(0, 8)
      const created = await s.admin.send<Json>('POST', '/api/admin/products', {
        slug: `gtin-${tag}`,
        name: `Scanned ${tag}`,
        description: 'Scanned at the till.',
        status: 'active',
        brand: 'Acme',
        variants: [
          {
            sku: `GTIN-0-${tag}`,
            name: 'Small',
            priceMinor: 1500,
            stock: 3,
            options: [],
            gtin: GTIN_A,
          },
          { sku: `GTIN-1-${tag}`, name: 'Large', priceMinor: 1900, stock: 2, options: [] },
        ],
      })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      const id = String(created.body.data!['id'])
      const [small, large] = variantsOf(created.body.data!).map((v) => String(v['id'])) as [
        string,
        string,
      ]

      const read = await adminRead(s, id)
      expect(
        [read['brand'], variantsOf(read).map((v) => [v['id'], v['gtin']])],
        'the admin read after create',
      ).toEqual([
        'Acme',
        [
          [small, GTIN_A],
          [large, null],
        ],
      ])

      // Brand alone: the brand changes, no variant does.
      const beforeBrand = identified(read)
      const renamed = await patch(s, id, { brand: 'Northwind' })
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200)
      const afterBrand = await adminRead(s, id)
      expect(afterBrand['brand']).toBe('Northwind')
      expect(identified(afterBrand), 'brand alone writes no variant').toEqual(beforeBrand)

      // The price repeated with a new GTIN: set, written, one product.updated.v1 carrying it, no price event.
      await pastMillisecond(
        Math.max(...Object.values(beforeBrand).map((v) => Date.parse(v.updatedAt))),
      )
      const seq = await maxSeq(s.raw)
      const gtinOnly = await patch(s, id, {
        variants: [{ id: large, priceMinor: 1900, gtin: GTIN_B }],
      })
      expect(gtinOnly.status, JSON.stringify(gtinOnly.body)).toBe(200)
      const afterGtin = identified(await adminRead(s, id))
      expect([afterGtin[large]!.gtin, afterGtin[large]!.priceMinor]).toEqual([GTIN_B, 1900])
      expect(Date.parse(afterGtin[large]!.updatedAt)).toBeGreaterThan(
        Date.parse(beforeBrand[large]!.updatedAt),
      )
      expect(afterGtin[small], 'the variant left out').toEqual(beforeBrand[small])
      const events = await correlated(s, seq, gtinOnly)
      expect(events.map((e) => e.type).filter((t) => t === PRICE_CHANGED || t === UPDATED)).toEqual(
        [UPDATED],
      )
      const carried = (
        events.find((e) => e.type === UPDATED)!.envelope.payload as { product: Json }
      ).product
      expect(identified(carried)[large]!.gtin, 'product.updated.v1 carries the GTIN').toBe(GTIN_B)

      // An entry without gtin keeps it, at a new price too.
      const kept = await patch(s, id, {
        variants: [
          { id: small, priceMinor: 1500 },
          { id: large, priceMinor: 2100 },
        ],
      })
      expect(kept.status, JSON.stringify(kept.body)).toBe(200)
      const afterKept = identified(await adminRead(s, id))
      expect([
        afterKept[small]!.gtin,
        afterKept[large]!.gtin,
        afterKept[large]!.priceMinor,
      ]).toEqual([GTIN_A, GTIN_B, 2100])

      // null and '' clear it.
      const cleared = await patch(s, id, {
        variants: [
          { id: small, priceMinor: 1500, gtin: null },
          { id: large, priceMinor: 2100, gtin: '' },
        ],
      })
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
      const afterClear = identified(await adminRead(s, id))
      expect([afterClear[small]!.gtin, afterClear[large]!.gtin]).toEqual([null, null])

      // A brand with surrounding spaces is stored trimmed.
      const spaced = await patch(s, id, { brand: '  Acme Lighting  ' })
      expect(spaced.status, JSON.stringify(spaced.body)).toBe(200)
      expect((await adminRead(s, id))['brand']).toBe('Acme Lighting')
    })
  })
}
