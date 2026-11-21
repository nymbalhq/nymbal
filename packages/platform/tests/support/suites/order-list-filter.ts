import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ORDER_STATUS_TRANSITIONS,
  paymentState,
  type Address,
  type OrderStatus,
  type PaymentState,
} from '@nymbalhq/types'
import { adminSession, type AdminSession } from '../audit-http.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, type Kernel } from '../kernel.js'
import { insertOrders, type OrderSpec } from '../listed-orders.js'
import { openRaw, type RawReader } from '../raw.js'
import { routeSchemas } from '../../../src/routes/schemas.js'

// The admin order list's filters run in the store's own query, on one dialect.
// - AC-1: property, the repository's `list` and `count` against a reference built in the test from the orders it
//   wrote: every filter (status, date bounds in each form the route admits, customer, q, shipping postcode prefix and
//   shipping country), any page, createdAt ties broken by sequence.
// - AC-2: over HTTP on 202 orders, `customer`, `q` and `dateTo` find the oldest one, and walking `offset` over a status
//   visits each of its orders once, with `meta.total` that status's count.
// - AC-3: over HTTP, `postcode` and `country` read the shipping address only, `meta.total` counts the whole filter, and
//   a blank, repeated or malformed value is refused at its key.

const STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]

/** What the reference knows of an order it wrote. */
interface Written {
  id: string
  orderNumber: string
  sequence: number
  status: OrderStatus
  email: string
  customerId: string | null
  createdAt: Date
  /** The shipping postcode and country as stored; undefined when the key was left out of the JSON. */
  postalCode: string | undefined
  country: string | undefined
}

interface Filter {
  status?: OrderStatus
  from?: string
  to?: string
  customer?: string
  q?: string
  postcode?: string
  country?: string
}

// ─── The reference: the Interface's predicates, over the orders the test wrote ───────────────────────────────────

/** Upper-cased with every U+0020 removed (a tab stays). */
const squeezed = (text: string): string => text.toUpperCase().replaceAll(' ', '')

const contains = (value: string | null, part: string): boolean =>
  (value ?? '').toLowerCase().includes(part.toLowerCase())

function matches(o: Written, f: Filter): boolean {
  if (f.status !== undefined && o.status !== f.status) return false
  if (f.from !== undefined && o.createdAt.getTime() < new Date(f.from).getTime()) return false
  if (f.to !== undefined && o.createdAt.getTime() > new Date(f.to).getTime()) return false
  if (
    f.customer !== undefined &&
    !contains(o.customerId, f.customer) &&
    !contains(o.email, f.customer)
  )
    return false
  if (f.q !== undefined && !contains(o.orderNumber, f.q) && !contains(o.email, f.q)) return false
  if (f.postcode !== undefined) {
    if (o.postalCode === undefined || o.postalCode === '') return false
    if (!squeezed(o.postalCode).startsWith(squeezed(f.postcode))) return false
  }
  if (f.country !== undefined) {
    if (o.country === undefined || o.country === '') return false
    if (o.country.toUpperCase() !== f.country.toUpperCase()) return false
  }
  return true
}

/** Every written order the filter admits, createdAt descending, then sequence descending. */
function reference(all: readonly Written[], f: Filter): Written[] {
  return all
    .filter((o) => matches(o, f))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.sequence - a.sequence)
}

// ─── Generators ──────────────────────────────────────────────────────────────────────────────────────────────────

const DAYS = ['2026-10-31', '2026-11-01', '2026-11-02'] as const
const TIMES = [
  '00:00:00.000',
  '07:00:00.000',
  '09:00:00.000',
  '09:00:00.123',
  '23:59:59.999',
] as const

/** A few instants, so orders often share one. */
const instantArb = fc
  .tuple(fc.constantFrom(...DAYS), fc.constantFrom(...TIMES))
  .map(([day, time]) => new Date(`${day}T${time}Z`))

/** A bound in each form the route admits: date-only, seconds with Z, milliseconds with Z, seconds with an offset. */
const boundArb = fc
  .tuple(fc.constantFrom(...DAYS), fc.constantFrom('date', 'secZ', 'msZ', 'offset', 'minus'))
  .map(([day, form]) =>
    form === 'date'
      ? day
      : form === 'secZ'
        ? `${day}T09:00:00Z`
        : form === 'msZ'
          ? `${day}T09:00:00.123Z`
          : form === 'offset'
            ? `${day}T09:00:00+02:00`
            : `${day}T07:00:00-02:00`,
  )

const textOf = (chars: readonly string[], min: number, max: number) =>
  fc.string({ unit: fc.constantFrom(...chars), minLength: min, maxLength: max })

const WILD = ['%', '_', '\\']
const emailArb = fc
  .tuple(textOf(['a', 'B', 'c', '.', ...WILD], 1, 6), fc.constantFrom('s.test', 'S.Test'))
  .map(([local, domain]) => `${local}@${domain}`)
const customerIdArb = fc.option(textOf(['c', 'U', '1', '-', ...WILD], 1, 6), { nil: null })
const POSTCODE_CHARS = ['S', 'w', '1', 'A', 'e', ' ', '\t', ...WILD]
/** A postcode as stored: absent from the JSON, empty, or any text of postcode characters, wildcards and a tab. */
const postalArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 6, arbitrary: textOf(POSTCODE_CHARS, 1, 8) },
)
const countryArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 6, arbitrary: fc.constantFrom('GB', 'gb', 'Gb', 'DE', 'de', 'US') },
)

interface OrderDraft {
  status: OrderStatus
  createdAt: Date
  email: string
  customerId: string | null
  suffix: string
  ship: { postalCode: string | undefined; country: string | undefined }
  bill: { postalCode: string | undefined; country: string | undefined }
}

const draftArb: fc.Arbitrary<OrderDraft> = fc.record({
  status: fc.constantFrom(...STATUSES),
  createdAt: instantArb,
  email: emailArb,
  customerId: customerIdArb,
  suffix: textOf(['x', 'Y', ...WILD], 0, 3),
  ship: fc.record({ postalCode: postalArb, country: countryArb }),
  bill: fc.record({ postalCode: postalArb, country: countryArb }),
})

/** A part of `text`, its case flipped at random, or a string of wildcards and letters. */
function partArb(texts: readonly string[]): fc.Arbitrary<string> {
  const loose = textOf(['a', 'B', 'c', 'x', ...WILD], 1, 3)
  const pool = texts.filter((t) => t !== '')
  if (pool.length === 0) return loose
  const cut = fc
    .tuple(fc.constantFrom(...pool), fc.nat(), fc.nat(), fc.boolean())
    .map(([text, a, b, upper]) => {
      const start = a % text.length
      const end = start + 1 + (b % (text.length - start))
      const part = text.slice(start, end)
      return upper ? part.toUpperCase() : part.toLowerCase()
    })
  return fc.oneof(cut, loose)
}

/** A postcode argument the route admits: something left once the spaces are gone. */
const postcodeArgArb = textOf(POSTCODE_CHARS, 1, 4).filter((p) => p.replaceAll(' ', '') !== '')

function filterArb(
  drafts: readonly OrderDraft[],
  numbers: readonly string[],
): fc.Arbitrary<Filter> {
  const emails = drafts.map((d) => d.email)
  const ids = drafts.flatMap((d) => (d.customerId === null ? [] : [d.customerId]))
  return fc.record(
    {
      status: fc.constantFrom(...STATUSES),
      from: boundArb,
      to: boundArb,
      customer: partArb([...emails, ...ids]),
      q: partArb([...emails, ...numbers]),
      postcode: postcodeArgArb,
      country: fc.constantFrom('GB', 'gb', 'de', 'US', 'FR'),
    },
    { requiredKeys: [] },
  )
}

const pageArb = fc.record({
  limit: fc.integer({ min: 1, max: 12 }),
  offset: fc.integer({ min: 0, max: 15 }),
})

/** An address with the shipping (or billing) postcode and country set, or left out of the JSON. */
function withPlace(part: { postalCode: string | undefined; country: string | undefined }): Address {
  const out: Record<string, unknown> = { ...address }
  if (part.postalCode === undefined) delete out['postalCode']
  else out['postalCode'] = part.postalCode
  if (part.country === undefined) delete out['country']
  else out['country'] = part.country
  return out as unknown as Address
}

const label = (f: Filter, page?: { limit: number; offset: number }) =>
  JSON.stringify({ ...f, ...page })

// ─── AC-2 and AC-3 over HTTP ─────────────────────────────────────────────────────────────────────────────────────

interface Issue {
  path: Array<string | number>
  message: string
}

interface Listed {
  status: number
  ids: string[] | undefined
  isArray: boolean
  total: unknown
  code: string | undefined
  issues: string[]
}

async function listed(admin: AdminSession, query: string): Promise<Listed> {
  const res = await admin.send<Array<{ id: string }>>('GET', `/api/admin/orders?${query}`)
  const error = res.body.error as { code?: string; context?: { issues?: Issue[] } } | undefined
  const data = res.body.data
  return {
    status: res.status,
    ids: Array.isArray(data) ? data.map((o) => o.id) : undefined,
    isArray: Array.isArray(data),
    total: res.body.meta?.['total'],
    code: error?.code,
    issues: (error?.context?.issues ?? []).map((i) => i.path.join('.')),
  }
}

const sorted = (ids: readonly string[]) => [...ids].sort()

export function orderListFilterSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
): void {
  describe(`AC-1: the order list's filters and count are the store's own query (${dialect})`, () => {
    let k: Kernel
    let raw: RawReader
    const written: Written[] = []
    let made = 0

    beforeAll(async () => {
      k = await start()
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await k?.close()
    })

    /** Writes the drafts and adds them, with the sequence each was given, to what the reference knows. */
    async function write(drafts: readonly OrderDraft[]): Promise<void> {
      const specs: OrderSpec[] = drafts.map((d) => {
        made += 1
        return {
          status: d.status,
          createdAt: d.createdAt,
          email: d.email,
          customerId: d.customerId,
          orderNumber: `ON-${made}${d.suffix}`,
          shippingAddress: withPlace(d.ship),
          billingAddress: withPlace(d.bill),
        }
      })
      const orders = await insertOrders(k, specs)
      const rows = await raw.rows<{ id: string; sequence: number | string }>(
        `SELECT id, sequence FROM orders WHERE id IN (${orders.map(() => '?').join(', ')})`,
        orders.map((o) => o.id),
      )
      const sequenceOf = new Map(rows.map((r) => [r.id, Number(r.sequence)]))
      for (const [i, o] of orders.entries()) {
        const d = drafts[i]!
        written.push({
          id: o.id,
          orderNumber: o.orderNumber,
          sequence: sequenceOf.get(o.id)!,
          status: d.status,
          email: d.email,
          customerId: d.customerId,
          createdAt: d.createdAt,
          postalCode: d.ship.postalCode,
          country: d.ship.country,
        })
      }
    }

    /** Orders drawn with 1-4 filters and pages over them; the filters' substrings come from the drawn orders. */
    const run = fc.array(draftArb, { minLength: 1, maxLength: 8 }).chain((drafts) => {
      const numbers = drafts.map((d, i) => `ON-${made + i + 1}${d.suffix}`)
      return fc.record({
        drafts: fc.constant(drafts),
        checks: fc.array(fc.tuple(filterArb(drafts, numbers), pageArb), {
          minLength: 1,
          maxLength: 4,
        }),
      })
    })
    const numRuns = dialect === 'sqlite' ? 60 : 40

    it('AC-1: property: for generated orders (shipping postcodes with and without spaces in any case, holding %, _, \\ and a tab, or missing; countries in any case or missing; emails, customer ids and order numbers holding %, _ and \\; createdAt ties) and any filter (status, from/to as a date, seconds with Z, milliseconds with Z or an offset, customer, q, postcode, country) on any page, list equals the reference: every order the predicates admit, createdAt desc then sequence desc, sliced', async () => {
      await fc.assert(
        fc.asyncProperty(run, async ({ drafts, checks }) => {
          await write(drafts)
          for (const [filter, page] of checks) {
            const expected = reference(written, filter)
            const listed = await k.store.read((tx) => k.repos.order.list(tx, { ...filter, ...page }))
            expect(
              listed.map((o) => o.id),
              label(filter, page),
            ).toEqual(expected.slice(page.offset, page.offset + page.limit).map((o) => o.id))
          }
        }),
        { numRuns },
      )
    }, 240_000)

    it('AC-1: property: for the same generated orders and any filter, count equals the number of orders the reference admits, whatever page a list of it would show', async () => {
      await fc.assert(
        fc.asyncProperty(run, async ({ drafts, checks }) => {
          await write(drafts)
          for (const [filter] of checks) {
            const counted = await k.store.read((tx) => k.repos.order.count(tx, filter))
            expect(counted, label(filter)).toBe(reference(written, filter).length)
          }
        }),
        { numRuns },
      )
    }, 240_000)
  })

  describe(`AC-2: a filter finds an order however old it is (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let admin: AdminSession
    const orders: Array<{
      id: string
      orderNumber: string
      status: OrderStatus
      email: string
      createdAt: Date
    }> = []

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      admin = await adminSession(k, served.baseUrl)
      // 202 orders a minute apart, the oldest first; every third confirmed.
      const newest = Date.parse('2026-11-05T12:00:00.000Z')
      const specs: OrderSpec[] = Array.from({ length: 202 }, (_, i) => ({
        status: i % 3 === 0 ? 'confirmed' : i % 3 === 1 ? 'pending' : 'shipped',
        createdAt: new Date(newest - (201 - i) * 60_000),
        email: `walk-${i}-${randomUUID()}@orders.test`,
      }))
      const placed = await insertOrders(k, specs)
      for (const [i, o] of placed.entries()) {
        orders.push({ ...o, email: specs[i]!.email!, createdAt: specs[i]!.createdAt! })
      }
    }, 120_000)

    afterAll(async () => {
      await served?.stop()
    })

    it('AC-2: on a store with 202 orders, customer=<the oldest order’s email>, q=<its number> and dateTo=<its createdAt>, each with limit=1, answer that order alone with meta.total 1', async () => {
      const oldest = orders[0]!
      const answers = await Promise.all([
        listed(admin, `customer=${encodeURIComponent(oldest.email)}&limit=1`),
        listed(admin, `q=${encodeURIComponent(oldest.orderNumber)}&limit=1`),
        listed(admin, `dateTo=${encodeURIComponent(oldest.createdAt.toISOString())}&limit=1`),
      ])

      expect(answers.map((a) => ({ status: a.status, ids: a.ids, total: a.total }))).toEqual(
        answers.map(() => ({ status: 200, ids: [oldest.id], total: 1 })),
      )
    }, 60_000)

    it('AC-2: walking offset by 50 over status=confirmed answers each confirmed order exactly once, newest first, and every page’s meta.total is the number of confirmed orders', async () => {
      const confirmed = orders
        .filter((o) => o.status === 'confirmed')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      const seen: string[] = []
      const totals: unknown[] = []
      for (let offset = 0; offset <= orders.length; offset += 50) {
        const page = await listed(admin, `status=confirmed&limit=50&offset=${offset}`)
        expect(page.status).toBe(200)
        totals.push(page.total)
        seen.push(...(page.ids ?? []))
        if ((page.ids ?? []).length < 50) break
      }

      expect(seen).toEqual(confirmed.map((o) => o.id))
      expect(new Set(seen).size).toBe(seen.length)
      expect(totals).toEqual(totals.map(() => confirmed.length))
    }, 60_000)
  })

  describe(`AC-3: postcode and country filter the shipping address, with a count (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let admin: AdminSession
    const ids: Record<string, string> = {}

    const ship = (postalCode: string, country: string): Address => ({
      ...address,
      postalCode,
      country,
    })

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      admin = await adminSession(k, served.baseUrl)
      const specs: Array<[string, OrderSpec]> = [
        ['sw1a', { status: 'confirmed', shippingAddress: ship('SW1A 1AA', 'GB') }],
        ['sw1v', { status: 'pending', shippingAddress: ship('sw1v3lp', 'gb') }],
        ['sw10', { status: 'shipped', shippingAddress: ship('SW10 9AB', 'GB') }],
        ['e1', { status: 'confirmed', shippingAddress: ship('E1 6AN', 'GB') }],
        [
          'billedSw1',
          {
            status: 'confirmed',
            shippingAddress: ship('M1 1AE', 'Gb'),
            billingAddress: ship('SW1A 2AA', 'GB'),
          },
        ],
        [
          'de',
          {
            status: 'confirmed',
            shippingAddress: ship('10117', 'DE'),
            billingAddress: ship('E1 6AN', 'GB'),
          },
        ],
        ['us', { status: 'pending', shippingAddress: ship('10001', 'US') }],
      ]
      const placed = await insertOrders(
        k,
        specs.map(([, spec]) => spec),
      )
      for (const [i, [name]] of specs.entries()) ids[name] = placed[i]!.id
    }, 60_000)

    afterAll(async () => {
      await served?.stop()
    })

    it('AC-3: postcode=sw1 answers exactly the orders whose shipping postcode starts SW1 once upper-cased without spaces (SW1A 1AA, sw1v3lp, SW10 9AB), not E1 6AN nor the order billed to SW1; with limit=1 meta.total is that set’s size; data is an array', async () => {
      const all = await listed(admin, 'postcode=sw1')
      const one = await listed(admin, 'postcode=sw1&limit=1')
      const expected = [ids['sw1a']!, ids['sw1v']!, ids['sw10']!]

      expect(all.status).toBe(200)
      expect(all.isArray).toBe(true)
      expect(sorted(all.ids ?? [])).toEqual(sorted(expected))
      expect(all.total).toBe(expected.length)
      expect(one.ids?.length).toBe(1)
      expect(expected).toContain(one.ids?.[0])
      expect(one.total).toBe(expected.length)
    })

    it('AC-3: country=gb, country=GB and country=UK answer the same set, every order shipped to GB in any case and none other, and with limit=1 meta.total is its size', async () => {
      const gb = [ids['sw1a']!, ids['sw1v']!, ids['sw10']!, ids['e1']!, ids['billedSw1']!]
      const answers = await Promise.all(
        ['country=gb', 'country=GB', 'country=UK', 'country=UK&limit=1'].map((q) =>
          listed(admin, q),
        ),
      )

      expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200])
      expect(answers.slice(0, 3).map((a) => sorted(a.ids ?? []))).toEqual([
        sorted(gb),
        sorted(gb),
        sorted(gb),
      ])
      expect(answers.map((a) => a.total)).toEqual(answers.map(() => gb.length))
      expect(answers[3]!.ids?.length).toBe(1)
    })

    it('AC-3: postcode=%25 (a lone %) answers no order and meta.total 0', async () => {
      const lone = await listed(admin, 'postcode=%25')

      expect({ status: lone.status, ids: lone.ids, total: lone.total }).toEqual({
        status: 200,
        ids: [],
        total: 0,
      })
    })

    it('AC-3: postcode=%20, a repeated postcode, country=GBR and country=G1 answer 400 validation.failed at query.postcode or query.country', async () => {
      const refused = await Promise.all(
        ['postcode=%20', 'postcode=SW1&postcode=E1', 'country=GBR', 'country=G1'].map((q) =>
          listed(admin, q),
        ),
      )

      expect(
        refused.map((r) => ({
          status: r.status,
          code: r.code,
          at: r.issues.filter((p) => /^query\./.test(p)),
        })),
      ).toEqual([
        { status: 400, code: 'validation.failed', at: ['query.postcode'] },
        { status: 400, code: 'validation.failed', at: ['query.postcode'] },
        { status: 400, code: 'validation.failed', at: ['query.country'] },
        { status: 400, code: 'validation.failed', at: ['query.country'] },
      ])
    })
  })
  describe(`AC-11: the list filters by payment, and status is fulfilment only (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let admin: AdminSession

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      admin = await adminSession(k, served.baseUrl)
    }, 60_000)

    afterAll(async () => {
      await served?.stop()
    })

    const FULFILMENT: OrderStatus[] = [
      'pending',
      'confirmed',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
    ]
    const PAYMENTS: PaymentState[] = ['unpaid', 'paid', 'partially_refunded', 'refunded']
    const TOTAL = 1200

    const moneyArb = fc
      .record({
        captured: fc.constantFrom(0, TOTAL),
        share: fc.constantFrom(0, 0.25, 0.5, 1),
      })
      .map(({ captured, share }) => ({
        capturedMinor: captured,
        refundedMinor: Math.round(captured * share),
      }))

    const batch = fc.array(
      fc.record({ status: fc.constantFrom(...FULFILMENT), money: moneyArb }),
      { minLength: 1, maxLength: 10 },
    )

    // Defect: the payment filter is ignored, mirrors paymentState wrongly at a boundary, leaves out meta.total, or does
    // not narrow beside status.
    it(`AC-11: property: payment=p answers exactly the orders whose paymentState is p, and with status=s exactly those also at s, meta.total counting them, on generated amounts at every status (${dialect})`, async () => {
      const mine: Array<{ id: string; status: OrderStatus; state: PaymentState }> = []
      const tag = randomUUID()
      await fc.assert(
        fc.asyncProperty(batch, async (drafts) => {
          const written = await insertOrders(
            k,
            drafts.map((d, i) => ({
              status: d.status,
              email: `pay-${tag}-${mine.length + i}@orders.test`,
              capturedMinor: d.money.capturedMinor,
              refundedMinor: d.money.refundedMinor,
            })),
          )
          for (const [i, o] of written.entries()) {
            mine.push({
              id: o.id,
              status: drafts[i]!.status,
              state: paymentState(drafts[i]!.money),
            })
          }
          const fetched = await Promise.all(
            PAYMENTS.flatMap((p) => [
              [p, undefined] as const,
              ...FULFILMENT.map((status) => [p, status] as const),
            ]).map(async ([p, status]) => ({
              p,
              status,
              answer: await listed(
                admin,
                `q=${encodeURIComponent(`pay-${tag}`)}&limit=200&payment=${p}${status === undefined ? '' : `&status=${status}`}`,
              ),
            })),
          )
          for (const { p, status, answer } of fetched) {
            const expected = mine
              .filter((o) => o.state === p && (status === undefined || o.status === status))
              .map((o) => o.id)
            const context = `payment=${p}${status === undefined ? '' : ` status=${status}`}`
            expect(answer.status, `${context}: ${JSON.stringify(answer)}`).toBe(200)
            expect(sorted(answer.ids ?? []), context).toEqual(sorted(expected))
            expect(answer.total, context).toBe(expected.length)
          }
        }),
        { numRuns: dialect === 'sqlite' ? 15 : 6 },
      )
    }, 180_000)

    /** Whether `text` names `value` as a word of its own: `refunded` is not named by `partially_refunded`. */
    const names = (text: string, value: string) =>
      new RegExp(`(^|[^A-Za-z_])${value}([^A-Za-z_]|$)`).test(text)

    // Defect: an alias keeps the money statuses alive on the status filter, or a refused answer names the wrong field.
    it(`AC-11: status=refunded and status=partially_refunded answer 400 validation.failed with one issue at query.status naming the six statuses and neither money value (${dialect})`, async () => {
      const refusals = await Promise.all(
        ['status=refunded', 'status=partially_refunded'].map(async (q) => {
          const res = await admin.send<Array<{ id: string }>>('GET', `/api/admin/orders?${q}`)
          const error = res.body.error as
            | { code?: string; context?: { issues?: Issue[] } }
            | undefined
          const issues = (error?.context?.issues ?? []).filter(
            (i) => i.path.join('.') === 'query.status',
          )
          return {
            q,
            status: res.status,
            code: error?.code,
            issues: issues.length,
            named: issues.flatMap((i) => FULFILMENT.filter((s) => names(i.message, s))),
            leaked: issues.flatMap((i) =>
              ['refunded', 'partially_refunded'].filter((m) => names(i.message, m)),
            ),
          }
        }),
      )
      expect(refusals).toEqual(
        ['status=refunded', 'status=partially_refunded'].map((q) => ({
          q,
          status: 400,
          code: 'validation.failed',
          issues: 1,
          named: FULFILMENT,
          leaked: [],
        })),
      )
    })

    // Defect: the assistant tool keeps describing a filter that no longer exists, or no way to find a refunded order.
    it(`AC-11: the admin order list tool’s description names the payment filter and its four values beside the status filter (${dialect})`, () => {
      const route = routeSchemas['GET /api/admin/orders']!
      const query = route.query as unknown as { shape: Record<string, { description?: string }> }
      const paymentDescription = query.shape['payment']?.description ?? ''
      const text = `${route.description} ${paymentDescription} ${query.shape['status']?.description ?? ''}`
      expect(PAYMENTS.filter((p) => !names(paymentDescription, p))).toEqual([])
      expect(['payment', 'status'].filter((f) => !names(text, f))).toEqual([])
    })
  })
}
