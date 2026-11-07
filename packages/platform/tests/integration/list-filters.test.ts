import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORDER_STATUS_TRANSITIONS, type Review } from '@nymbalhq/types'
import { jsonSchemaOf } from '../../src/mcp/registry.js'
import { routeSchemas } from '../../src/routes/schemas.js'
import { adminSession, type AdminSession } from '../support/audit-http.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { insertOrders } from '../support/listed-orders.js'
import { productIn, reviewer } from '../support/reviews.js'

// The admin lists and the product search over HTTP on a served SQLite kernel: a status filter offers exactly the
// statuses the rows have and refuses any other naming them, a date filter refuses what it cannot read and covers a
// date's whole UTC day, a search without words is refused, and a pending review names its product as it is now.

interface Issue {
  path: Array<string | number>
  message: string
}

interface Answer<T> {
  status: number
  code: string | undefined
  data: T | undefined
  issues: Issue[]
}

type Row = Record<string, unknown>

const dotted = (issue: Issue) => issue.path.join('.')

/** Whether `text` names `value` as a word of its own: `refunded` is not named by `partially_refunded`. */
const names = (text: string, value: string) =>
  new RegExp(`(^|[^A-Za-z_])${value}([^A-Za-z_]|$)`).test(text)

let k: Kernel
let served: ServedKernel
let admin: AdminSession

async function get<T = Row[]>(
  path: string,
  query: Record<string, string> = {},
): Promise<Answer<T>> {
  const search = new URLSearchParams(query).toString()
  const res = await admin.send<T>('GET', search === '' ? path : `${path}?${search}`)
  const error = res.body.error as { code?: string; context?: { issues?: Issue[] } } | undefined
  return {
    status: res.status,
    code: error?.code,
    data: res.body.data,
    issues: error?.context?.issues ?? [],
  }
}

/** The values the route's status filter offers, as its tool's inputSchema says; none when it offers no enum. */
function statusEnum(key: string): string[] {
  const schema = jsonSchemaOf(routeSchemas[key]!) as {
    properties?: Record<string, { enum?: unknown[] }>
  }
  return (schema.properties?.['status']?.enum ?? []).map(String)
}

interface ListRoute {
  path: string
  key: string
  /** What identifies one row of the list. */
  idOf: (row: Row) => string
  /** Every status a row can have. */
  statuses: string[]
  /** A status the store has never had, as a model might guess one. */
  wrong: string
}

const ROUTES: ListRoute[] = [
  {
    path: '/api/admin/orders',
    key: 'GET /api/admin/orders',
    idOf: (row) => String(row['id']),
    statuses: Object.keys(ORDER_STATUS_TRANSITIONS),
    wrong: 'awaiting_payment',
  },
  {
    path: '/api/admin/products',
    key: 'GET /api/admin/products',
    idOf: (row) => String(row['id']),
    statuses: ['draft', 'active', 'archived'],
    wrong: 'published',
  },
  {
    path: '/api/admin/inventory',
    key: 'GET /api/admin/inventory',
    idOf: (row) => String(row['variantId']),
    statuses: ['in_stock', 'low_stock', 'out_of_stock'],
    wrong: 'low',
  },
]

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  admin = await adminSession(k, served.baseUrl)
  // At least one row in every status of every list.
  await insertOrders(
    k,
    Object.keys(ORDER_STATUS_TRANSITIONS).map((status) => ({
      status: status as keyof typeof ORDER_STATUS_TRANSITIONS,
    })),
  )
  for (const status of ['draft', 'active', 'archived'] as const) await productIn(k, status)
  await seedVariant(k, 10, { lowStockThreshold: 0 })
  await seedVariant(k, 2, { lowStockThreshold: 5 })
  await seedVariant(k, 0)
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

describe('a status filter offers exactly the statuses the rows have', () => {
  for (const route of ROUTES) {
    it(`AC-2: GET ${route.path}: every status the enum offers answers 200 with rows in that status only, and the filtered lists together are the unfiltered list`, async () => {
      const values = statusEnum(route.key)
      const all = await get(route.path, { limit: '200' })
      const filtered = await Promise.all(
        values.map(async (value) => ({
          value,
          answer: await get(route.path, { status: value, limit: '200' }),
        })),
      )

      expect(all.status, JSON.stringify(all)).toBe(200)
      expect(
        filtered.map(({ value, answer }) => [
          value,
          answer.status,
          [...new Set((answer.data ?? []).map((row) => String(row['status'])))],
        ]),
      ).toEqual(values.map((value) => [value, 200, [value]]))
      expect(filtered.flatMap(({ answer }) => (answer.data ?? []).map(route.idOf)).sort()).toEqual(
        all.data!.map(route.idOf).sort(),
      )
    })

    it(`AC-2: GET ${route.path}?status=${route.wrong} answers 400 validation.failed with one issue at query.status naming every status, and no list`, async () => {
      const answer = await get(route.path, { status: route.wrong })

      expect([answer.status, answer.code, answer.data]).toEqual([
        400,
        'validation.failed',
        undefined,
      ])
      expect(
        answer.issues
          .filter((issue) => dotted(issue) === 'query.status')
          .map((issue) => route.statuses.filter((value) => !names(issue.message, value))),
      ).toEqual([[]])
    })
  }
})

describe('a search needs words', () => {
  it('AC-5: GET /api/products/search with q missing, empty or blank, with or without category, answers 400 validation.failed with an issue at query.q', async () => {
    const queries: Array<Record<string, string>> = [
      {},
      { q: '' },
      { q: '  ' },
      { category: 'mugs' },
      { q: '', category: 'mugs' },
      { q: '  ', category: 'mugs' },
    ]

    const answers = await Promise.all(
      queries.map(async (query) => {
        const res = await fetch(
          `${served.baseUrl}/api/products/search?${new URLSearchParams(query).toString()}`,
          { headers: { accept: 'application/json' } },
        )
        const body = (await res.json()) as {
          error?: { code?: string; context?: { issues?: Issue[] } }
        }
        return {
          query,
          status: res.status,
          code: body.error?.code,
          atQ: (body.error?.context?.issues ?? []).some((issue) => dotted(issue) === 'query.q'),
        }
      }),
    )

    expect(answers).toEqual(
      queries.map((query) => ({ query, status: 400, code: 'validation.failed', atQ: true })),
    )
  })
})

describe('a pending review names its product as it is now', () => {
  async function pending(): Promise<
    Array<Review & { productName?: unknown; productSlug?: unknown }>
  > {
    const answer =
      await get<Array<Review & { productName?: unknown; productSlug?: unknown }>>(
        '/api/admin/reviews',
      )
    expect(answer.status, JSON.stringify(answer)).toBe(200)
    return answer.data!
  }

  const stored = (id: string) => k.store.read((tx) => k.repos.review.findById(tx, id))

  it("AC-6: GET /api/admin/reviews answers a pending review as stored plus its product's current name and slug, and after the product is renamed the next read carries the new name", async () => {
    const productId = await productIn(k, 'active')
    const who = await reviewer(served.baseUrl)
    const submitted = await who.submit({
      productId,
      rating: 4,
      title: 'Holds tea',
      body: 'Kept it hot all morning.',
    })
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    const reviewId = submitted.body.data!.review.id

    const read = async () => {
      const product = await k.services.product.getById(productId)
      const item = (await pending()).find((r) => r.id === reviewId)
      return {
        item,
        expected: {
          ...(await stored(reviewId))!,
          productName: product.name,
          productSlug: product.slug,
        },
      }
    }
    const before = await read()
    await k.services.product.update(productId, { name: `${before.expected.productName} Renamed` })
    const after = await read()

    expect(after.expected.productName).not.toBe(before.expected.productName)
    expect([before.item, after.item]).toEqual([before.expected, after.expected])
  })

  it('AC-6: a pending review whose product was deleted is still listed, as stored, with productName and productSlug null', async () => {
    const productId = await productIn(k, 'active')
    const who = await reviewer(served.baseUrl)
    const submitted = await who.submit({
      productId,
      rating: 2,
      title: 'Chipped',
      body: 'Arrived with a chip in the rim.',
    })
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    const reviewId = submitted.body.data!.review.id

    await k.services.product.delete(productId)

    expect((await pending()).filter((r) => r.id === reviewId)).toEqual([
      { ...(await stored(reviewId))!, productName: null, productSlug: null },
    ])
  })
})

describe('a date filter reads what it says and refuses what it cannot', () => {
  it('AC-10: GET /api/admin/orders with an unparseable dateFrom or dateTo (last week, 2026-13-40, yesterday) answers 400 validation.failed with an issue at that key, and no list', async () => {
    const cases = ['dateFrom', 'dateTo'].flatMap((key) =>
      ['last week', '2026-13-40', 'yesterday'].map((value) => ({ key, value })),
    )

    const answers = await Promise.all(
      cases.map(async ({ key, value }) => {
        const answer = await get('/api/admin/orders', { [key]: value })
        return {
          key,
          value,
          status: answer.status,
          code: answer.code,
          listed: answer.data !== undefined,
          atKey: answer.issues.some((issue) => dotted(issue) === `query.${key}`),
        }
      }),
    )

    expect(answers).toEqual(
      cases.map(({ key, value }) => ({
        key,
        value,
        status: 400,
        code: 'validation.failed',
        listed: false,
        atKey: true,
      })),
    )
  })

  it('AC-10: dateFrom=D&dateTo=D answers the orders placed on all of UTC day D, and a date-time bound with Z or an offset cuts the unfiltered list at that instant', async () => {
    const day = '2020-03-01'
    const placed = [
      '2020-02-29T23:59:59.999Z',
      '2020-03-01T00:00:00.000Z',
      '2020-03-01T09:00:00.000Z',
      '2020-03-01T23:59:59.999Z',
      '2020-03-02T00:00:00.000Z',
    ]
    await insertOrders(
      k,
      placed.map((at) => ({ status: 'confirmed' as const, createdAt: new Date(at) })),
    )
    const all = await get('/api/admin/orders', { limit: '200' })
    expect(all.status).toBe(200)
    expect(all.data!.length).toBeLessThan(200)
    const idsBetween = (from: number, to: number) =>
      all
        .data!.filter((row) => {
          const at = new Date(String(row['createdAt'])).getTime()
          return at >= from && at <= to
        })
        .map((row) => String(row['id']))
        .sort()
    const idsOf = (answer: Answer<Row[]>) => [
      answer.status,
      (answer.data ?? []).map((row) => String(row['id'])).sort(),
    ]

    const wholeDay = await get('/api/admin/orders', { dateFrom: day, dateTo: day, limit: '200' })
    const offset = await get('/api/admin/orders', {
      dateFrom: '2020-03-01T10:00:00+02:00',
      dateTo: '2020-03-01T23:00:00Z',
      limit: '200',
    })

    expect(idsOf(wholeDay)).toEqual([
      200,
      idsBetween(Date.parse('2020-03-01T00:00:00.000Z'), Date.parse('2020-03-01T23:59:59.999Z')),
    ])
    expect(idsOf(offset)).toEqual([
      200,
      idsBetween(Date.parse('2020-03-01T08:00:00.000Z'), Date.parse('2020-03-01T23:00:00.000Z')),
    ])
  })
})
