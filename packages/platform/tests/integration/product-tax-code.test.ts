import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CheckoutQuote, OrderLineItem, PaymentIntentParams } from '@nymbalhq/types'
import { adminSession, type AdminSession, type Answer } from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { addLine, readCart, type Shop } from '../support/promotions.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import { DESTINATIONS, taxOnTop, withTax } from '../support/tax.js'

// A product's own tax code through the admin API on a served kernel (SQLite) whose native engine has one rate row of
// 20% that lists `reduced` at 5%: what the routes store and refuse, and what checkout then taxes the product's lines at.

const STANDARD = 20
const REDUCED = 5

type Json = Record<string, unknown>

interface Store {
  k: Kernel
  served: ServedKernel
  admin: AdminSession
  raw: RawReader
  intents: Array<{ id: string; amountMinor: number }>
}

let s: Store

beforeAll(async () => {
  const k = await createKernel({
    dialect: 'sqlite',
    configure: withTax({
      rates: [{ country: 'GB', percent: STANDARD, codes: { reduced: REDUCED } }],
    }),
  })
  const served = await serveKernel(k)
  const intents: Store['intents'] = []
  const payments = k.app.adapters.payments
  const create = payments.createPaymentIntent.bind(payments)
  payments.createPaymentIntent = async (params: PaymentIntentParams) => {
    const intent = await create(params)
    intents.push({ id: intent.id, amountMinor: intent.amountMinor })
    return intent
  }
  s = {
    k,
    served,
    admin: await adminSession(k, served.baseUrl),
    raw: openRaw(k.dialect, k.target),
    intents,
  }
}, 60_000)

afterAll(async () => {
  await s?.raw.close()
  await s?.served.stop()
})

const tag = () => randomUUID().slice(0, 8)

function productBody(t: string, over: Json = {}): Json {
  return {
    slug: `taxed-${t}`,
    name: `Taxed ${t}`,
    status: 'active',
    variants: [{ sku: `TX-${t}`, name: 'Default', priceMinor: 1_000, stock: 20, options: [] }],
    ...over,
  }
}

async function made(over: Json = {}): Promise<Json> {
  const res = await s.admin.send<Json>('POST', '/api/admin/products', productBody(tag(), over))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data!
}

async function adminRead(id: string): Promise<Json> {
  const res = await s.admin.send<Json>('GET', `/api/admin/products/${id}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

async function patched(id: string, body: Json): Promise<Json> {
  const res = await s.admin.send<Json>('PATCH', `/api/admin/products/${id}`, body)
  expect(res.status, `PATCH ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`).toBe(200)
  return res.body.data!
}

/** The product's code as the admin read answers it, null when it has none. */
const codeOf = (product: Json): unknown => product['taxCode'] ?? null

/** The refusal's code and issue paths, joined (`body.taxCode`). */
function refusalOf(answer: Answer<Json>): [number, string | undefined, string[]] {
  const error = answer.body.error as
    | { code?: string; context?: { issues?: Array<{ path: unknown[] }> } }
    | undefined
  return [answer.status, error?.code, (error?.context?.issues ?? []).map((i) => i.path.join('.'))]
}

const NOT_CODES: ReadonlyArray<[string, unknown]> = [
  ['empty', ''],
  ['blanks only', '   '],
  ['65 characters', 'c'.repeat(65)],
  ['a number', 42],
]

describe('the admin product routes store a product’s tax code', () => {
  // Kills: the parse dropping taxCode, so a product created with a code keeps none.
  it('AC-1: POST /api/admin/products with taxCode reduced answers 201 with it, and GET /api/admin/products/:id reads it back', async () => {
    const product = await made({ taxCode: 'reduced' })

    expect(codeOf(product)).toBe('reduced')
    expect(codeOf(await adminRead(String(product['id'])))).toBe(codeOf(product))
  })

  // Kills: an update that sets no code, or one without the key that clears it.
  it('AC-1: PATCH with { taxCode: zero } changes it, with { name } alone leaves it as it was, and with { taxCode: null } clears it', async () => {
    const product = await made({ taxCode: 'reduced' })
    const id = String(product['id'])

    await patched(id, { taxCode: 'zero' })
    const zero = await adminRead(id)
    await patched(id, { name: `${String(product['name'])} renamed` })
    const renamed = await adminRead(id)
    await patched(id, { taxCode: null })
    const cleared = await adminRead(id)

    expect([codeOf(product), codeOf(zero), codeOf(renamed), codeOf(cleared)]).toEqual([
      'reduced',
      'zero',
      'zero',
      null,
    ])
    expect(renamed['name']).toBe(`${String(product['name'])} renamed`)
  })

  // Kills: a code stored with the blanks typed around it, which no rate row's key then matches.
  it('AC-1: a code sent as "  reduced  " is stored as reduced, on create and on update', async () => {
    const created = await made({ taxCode: '  reduced  ' })
    const plain = await made()
    await patched(String(plain['id']), { taxCode: '  reduced  ' })

    expect(codeOf(await adminRead(String(created['id'])))).toBe('reduced')
    expect(codeOf(await adminRead(String(plain['id'])))).toBe('reduced')
  })

  // Kills: an empty, blank, overlong or non-text code accepted (or silently dropped) instead of refused.
  it('AC-1: a taxCode of "", blanks only, 65 characters or a number is 400 validation.failed naming taxCode on create and on update, and changes nothing', async () => {
    const product = await made({ taxCode: 'reduced' })
    const id = String(product['id'])
    const before = await adminRead(id)

    for (const [label, bad] of NOT_CODES) {
      const body = productBody(tag(), { taxCode: bad })
      const seq = await maxSeq(s.raw)
      const create = await s.admin.send<Json>('POST', '/api/admin/products', body)
      const update = await s.admin.send<Json>('PATCH', `/api/admin/products/${id}`, {
        name: 'Never saved',
        taxCode: bad,
      })

      expect(refusalOf(create), `${label}: create ${JSON.stringify(create.body)}`).toEqual([
        400,
        'validation.failed',
        ['body.taxCode'],
      ])
      expect(refusalOf(update), `${label}: update ${JSON.stringify(update.body)}`).toEqual([
        400,
        'validation.failed',
        ['body.taxCode'],
      ])
      expect(await s.raw.count('products', 'slug = ?', [body['slug']]), `${label}: products`).toBe(
        0,
      )
      expect(await adminRead(id), `${label}: the product`).toEqual(before)
      expect(
        (await eventRows(s.raw, 'seq > ?', [seq])).map((e) => e.type),
        `${label}: events`,
      ).toEqual([])
    }
  })

  type Step = { kind: 'omit' } | { kind: 'null' } | { kind: 'set'; code: string; pad: string }

  const arbCode = fc.stringMatching(/^[a-z0-9_-]{1,64}$/)
  const arbStep: fc.Arbitrary<Step> = fc.oneof(
    fc.constant<Step>({ kind: 'omit' }),
    fc.constant<Step>({ kind: 'null' }),
    fc.record({
      kind: fc.constant('set' as const),
      code: arbCode,
      pad: fc.constantFrom('', ' ', '  '),
    }),
  )

  // Kills: an update without the key that clears or rewrites the code; a null that leaves it; a trim missed.
  it('AC-1: property: over a sequence of updates that omit taxCode, clear it or set it (padded or not), the stored code is the last one set, trimmed, or null after a clear', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(arbCode, { nil: null }),
        fc.array(arbStep, { minLength: 1, maxLength: 5 }),
        async (initial, steps) => {
          const product = await made(initial === null ? {} : { taxCode: initial })
          const id = String(product['id'])
          let model: string | null = initial
          for (const [i, step] of steps.entries()) {
            if (step.kind === 'omit') await patched(id, { name: `Renamed ${i}` })
            else if (step.kind === 'null') await patched(id, { taxCode: null })
            else await patched(id, { taxCode: `${step.pad}${step.code}${step.pad}` })
            if (step.kind === 'null') model = null
            if (step.kind === 'set') model = step.code
            expect(codeOf(await adminRead(id)), JSON.stringify(steps.slice(0, i + 1))).toBe(model)
          }
        },
      ),
      { numRuns: 12 },
    )
  }, 60_000)
})

describe('checkout taxes a product at the code the route stored', () => {
  async function quote(shop: Shop): Promise<CheckoutQuote> {
    const res = await shop.call<CheckoutQuote>('POST', '/api/checkout/quote', {
      shippingAddress: DESTINATIONS[0]!.shipTo,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.data!
  }

  // Kills: a code the route stores where checkout does not read it (a second column, a stale snapshot), so the form's
  // field changes no tax.
  it('AC-2: a product given taxCode reduced through PATCH is quoted 5% where it was quoted 20%, and charged it; cleared through the route, it is quoted 20% again', async () => {
    const qty = 3
    const product = await made()
    const id = String(product['id'])
    const variantId = String((product['variants'] as Json[])[0]!['id'])
    const amount = 1_000 * qty
    await s.k.app.relay.drain()
    const shop = await primedShopper(s.served.baseUrl)
    expect((await readCart(shop)).status).toBe(200)
    const added = await addLine(
      shop,
      { productId: id, variantId, priceMinor: 1_000, initialStock: 20 },
      qty,
    )
    expect(added.status, JSON.stringify(added.body)).toBe(200)

    const lineTax = (q: CheckoutQuote) => q.totals.lines.find((l) => l.id === variantId)?.taxMinor
    const standard = await quote(shop)
    await patched(id, { taxCode: 'reduced' })
    const reduced = await quote(shop)

    expect([lineTax(standard), lineTax(reduced)]).toEqual([
      taxOnTop(amount, STANDARD),
      taxOnTop(amount, REDUCED),
    ])
    expect(reduced.totals.taxTotalMinor).toBe(
      standard.totals.taxTotalMinor - taxOnTop(amount, STANDARD) + taxOnTop(amount, REDUCED),
    )

    const shipTo = DESTINATIONS[0]!.shipTo
    const placed = await shop.call<{ orderId: string; paymentIntent: { id: string } }>(
      'POST',
      '/api/checkout',
      {
        email: `buyer-${randomUUID()}+stub-pending@tax-code.test`,
        billingAddress: shipTo,
        shippingAddress: shipTo,
        expectedTotalMinor: reduced.totals.totalMinor,
      },
    )
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    const answer = placed.body.data!
    const order = await s.k.store.read(
      async (tx) => (await s.k.repos.order.findById(tx, answer.orderId))!,
    )
    const row = await s.raw.one<{ tax_total_minor: number; total_minor: number }>(
      'SELECT tax_total_minor, total_minor FROM orders WHERE id = ?',
      [answer.orderId],
    )
    expect(order.lineItems.map((l: OrderLineItem) => [l.variantId, l.lineTaxMinor])).toEqual([
      [variantId, taxOnTop(amount, REDUCED)],
    ])
    expect(row.tax_total_minor).toBe(reduced.totals.taxTotalMinor)
    expect(s.intents.find((i) => i.id === answer.paymentIntent.id)?.amountMinor).toBe(
      row.total_minor,
    )

    const again = await primedShopper(s.served.baseUrl)
    expect((await readCart(again)).status).toBe(200)
    await patched(id, { taxCode: null })
    const readded = await addLine(
      again,
      { productId: id, variantId, priceMinor: 1_000, initialStock: 20 },
      qty,
    )
    expect(readded.status, JSON.stringify(readded.body)).toBe(200)
    expect(lineTax(await quote(again))).toBe(lineTax(standard))
  })
})
