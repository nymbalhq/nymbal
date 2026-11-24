import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminSession,
  auditRows,
  outcomesOf,
  type AdminSession,
  type Answer,
} from '../support/audit.js'
import { untilDelivered } from '../support/history.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { adminBrandGtinSuite } from '../support/suites/admin-brand-gtin.js'

// A product's brand and its variants' GTINs through the admin API on SQLite: saved and served (the suite, which the
// Postgres suite runs too), refused whole when a GTIN is not one or a brand is too long, dropped from a copy, and
// served by the storefront's product read.

adminBrandGtinSuite('sqlite', { open: () => createKernel({ dialect: 'sqlite' }) })

const GTIN_A = '4006381333931'
const GTIN_B = '036000291452'
const NOT_GTINS = ['123', '4006381333932', '978-0-306-40615-7']

type Json = Record<string, unknown>

interface Store {
  served: ServedKernel
  admin: AdminSession
  raw: RawReader
}

let s: Store

beforeAll(async () => {
  const k = await createKernel({ dialect: 'sqlite' })
  const served = await serveKernel(k)
  s = { served, admin: await adminSession(k, served.baseUrl), raw: openRaw(k.dialect, k.target) }
}, 60_000)

afterAll(async () => {
  await s?.raw.close()
  await s?.served.stop()
})

const variantsOf = (snapshot: Json): Json[] => snapshot['variants'] as Json[]

function productBody(tag: string, over: Json = {}): Json {
  return {
    slug: `brand-${tag}`,
    name: `Branded ${tag}`,
    description: 'Branded and scanned.',
    status: 'active',
    brand: 'Acme',
    variants: [
      { sku: `BR-0-${tag}`, name: 'Small', priceMinor: 1500, stock: 3, options: [], gtin: GTIN_A },
      { sku: `BR-1-${tag}`, name: 'Large', priceMinor: 1900, stock: 2, options: [], gtin: GTIN_B },
    ],
    ...over,
  }
}

async function made(tag: string): Promise<Json> {
  const res = await s.admin.send<Json>('POST', '/api/admin/products', productBody(tag))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data!
}

async function adminRead(id: string): Promise<Json> {
  const res = await s.admin.send<Json>('GET', `/api/admin/products/${id}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

/** The refusal's issue paths, joined (`body.variants.1.gtin`). */
function issuePaths(answer: Answer<Json>): string[] {
  const error = answer.body.error as
    | { context?: { issues?: Array<{ path: unknown[] }> } }
    | undefined
  return (error?.context?.issues ?? []).map((i) => i.path.join('.'))
}

/** What a refused request must leave behind: no event after `seq`, and no applied audit entry in its correlation. */
async function leftNothing(seq: number, answer: Answer<Json>, label: string): Promise<void> {
  expect(
    (await eventRows(s.raw, 'seq > ?', [seq])).map((e) => e.type),
    `${label}: events`,
  ).toEqual([])
  const rows =
    answer.correlationId === null
      ? []
      : await auditRows(s.raw, 'correlation_id = ?', [answer.correlationId])
  expect(
    outcomesOf(rows).filter((o) => o === 'applied'),
    `${label}: applied audit entries`,
  ).toEqual([])
}

describe('a GTIN that is not one, or a brand too long, is refused whole', () => {
  it('AC-3: a create whose second variant’s gtin is 123, a wrong check digit or a hyphenated ISBN-13 answers 400 naming variants.1.gtin, and no product, event or applied audit entry is written', async () => {
    for (const bad of NOT_GTINS) {
      const tag = randomUUID().slice(0, 8)
      const body = productBody(tag)
      ;(variantsOf(body)[1] as Json)['gtin'] = bad
      const seq = await maxSeq(s.raw)
      const res = await s.admin.send<Json>('POST', '/api/admin/products', body)

      expect([res.status, issuePaths(res)], `${bad}: ${JSON.stringify(res.body)}`).toEqual([
        400,
        ['body.variants.1.gtin'],
      ])
      expect(await s.raw.count('products', 'slug = ?', [body['slug']]), `${bad}: products`).toBe(0)
      await leftNothing(seq, res, bad)
    }
  })

  it('AC-3: an update sending a valid brand and GTIN beside a variant whose gtin is not a GTIN answers 400 naming variants.1.gtin, and the product, its variants, the log and the audit log are as before', async () => {
    const product = await made(randomUUID().slice(0, 8))
    const id = String(product['id'])
    const [small, large] = variantsOf(product).map((v) => String(v['id'])) as [string, string]
    const before = await adminRead(id)

    for (const bad of NOT_GTINS) {
      const seq = await maxSeq(s.raw)
      const res = await s.admin.send<Json>('PATCH', `/api/admin/products/${id}`, {
        brand: 'Northwind',
        variants: [
          { id: small, priceMinor: 1200, gtin: GTIN_B },
          { id: large, priceMinor: 1900, gtin: bad },
        ],
      })

      expect([res.status, issuePaths(res)], `${bad}: ${JSON.stringify(res.body)}`).toEqual([
        400,
        ['body.variants.1.gtin'],
      ])
      expect(await adminRead(id), `${bad}: the product`).toEqual(before)
      await leftNothing(seq, res, bad)
    }
  })

  it('AC-3: a brand of 121 characters answers 400 naming brand on create and update, with nothing written; one of 120 is saved', async () => {
    const product = await made(randomUUID().slice(0, 8))
    const id = String(product['id'])
    const small = String(variantsOf(product)[0]!['id'])
    const before = await adminRead(id)
    const long = 'B'.repeat(121)

    const tag = randomUUID().slice(0, 8)
    let seq = await maxSeq(s.raw)
    const create = await s.admin.send<Json>(
      'POST',
      '/api/admin/products',
      productBody(tag, { brand: long }),
    )
    expect([create.status, issuePaths(create)], JSON.stringify(create.body)).toEqual([
      400,
      ['body.brand'],
    ])
    expect(await s.raw.count('products', 'slug = ?', [`brand-${tag}`])).toBe(0)
    await leftNothing(seq, create, 'create')

    seq = await maxSeq(s.raw)
    const update = await s.admin.send<Json>('PATCH', `/api/admin/products/${id}`, {
      brand: long,
      variants: [{ id: small, priceMinor: 1200, gtin: GTIN_B }],
    })
    expect([update.status, issuePaths(update)], JSON.stringify(update.body)).toEqual([
      400,
      ['body.brand'],
    ])
    expect(await adminRead(id), 'the product').toEqual(before)
    await leftNothing(seq, update, 'update')

    const fits = long.slice(1)
    const saved = await s.admin.send<Json>('PATCH', `/api/admin/products/${id}`, { brand: fits })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect((await adminRead(id))['brand']).toBe(fits)
  })
})

describe('a copy and the storefront read', () => {
  it('AC-4: POST /api/admin/products/:id/duplicate answers a copy with the same brand and every variant’s gtin null', async () => {
    const product = await made(randomUUID().slice(0, 8))
    const res = await s.admin.send<Json>(
      'POST',
      `/api/admin/products/${String(product['id'])}/duplicate`,
      {},
    )
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const copy = res.body.data!

    expect([product['brand'], copy['brand']]).toEqual(['Acme', 'Acme'])
    expect(variantsOf(copy).map((v) => v['gtin'])).toEqual(variantsOf(product).map(() => null))
    expect(variantsOf(await adminRead(String(copy['id']))).map((v) => v['gtin'])).toEqual(
      variantsOf(product).map(() => null),
    )
  })

  it("AC-5: GET /api/products/:slug answers the product's brand and each variant's gtin as created, and as they are after an update", async () => {
    const product = await made(randomUUID().slice(0, 8))
    const id = String(product['id'])
    const slug = String(product['slug'])
    const [small, large] = variantsOf(product).map((v) => String(v['id'])) as [string, string]

    const served = async () => {
      await untilDelivered(s.raw)
      const res = await fetch(new URL(`/api/products/${slug}`, s.served.baseUrl))
      expect(res.status).toBe(200)
      const { data } = (await res.json()) as { data: Json }
      return {
        brand: data['brand'],
        gtins: Object.fromEntries(variantsOf(data).map((v) => [v['id'], v['gtin']])),
      }
    }

    expect(await served(), 'as created').toEqual({
      brand: 'Acme',
      gtins: { [small]: GTIN_A, [large]: GTIN_B },
    })

    const res = await s.admin.send<Json>('PATCH', `/api/admin/products/${id}`, {
      brand: 'Northwind',
      variants: [
        { id: small, priceMinor: 1500, gtin: null },
        { id: large, priceMinor: 1900, gtin: GTIN_A },
      ],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await served(), 'after the update').toEqual({
      brand: 'Northwind',
      gtins: { [small]: null, [large]: GTIN_A },
    })
  })
})
