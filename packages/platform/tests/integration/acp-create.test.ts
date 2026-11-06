import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acpExample, validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  ACP_ERROR,
  ACP_LINKS,
  acpClient,
  acpStore,
  cartOverHttp,
  cartPairs,
  CHECKOUT_SESSION,
  createBody,
  errorMessages,
  requestPairs,
  seedPool,
  sessionPairs,
  totalOf,
  type AcpAnswer,
  type AcpSession,
  type Line,
  type PoolVariant,
} from '../support/acp.js'
import { storedCartSource, type AgentStore } from '../support/agents.js'
import { committedCount, committedStock } from '../support/mcp.js'

// AC-4: a create opens a session on a cart of exactly the agent's lines, priced by the store, and nothing more: no
// stock held, no order. AC-5: a create with any line the store refuses opens no cart at all.

const POOL = 12
const BULK = 51

let store: AgentStore
/** In stock, at distinct prices. */
let pool: PoolVariant[]
/** One variant at stock 3. */
let scarce: PoolVariant
/** 51 more in-stock variants, for the bound on distinct ids. */
let bulk: PoolVariant[]
let handlerUrls: { config_schema: unknown; instrument_schemas: unknown }

beforeAll(async () => {
  store = await acpStore()
  pool = await seedPool(
    store,
    Array.from({ length: POOL }, (_, i) => ({ priceMinor: 199 + i * 1013, stock: 1_000 })),
  )
  scarce = (await seedPool(store, [{ priceMinor: 4_999, stock: 3 }]))[0]!
  bulk = await seedPool(
    store,
    Array.from({ length: BULK }, (_, i) => ({ priceMinor: 100 + i, stock: 10 })),
  )
  const example = acpExample('create_checkout_session_response') as {
    capabilities: { payment: { handlers: Array<Record<string, unknown>> } }
  }
  const tokenized = example.capabilities.payment.handlers.find((h) => h['id'] === 'card_tokenized')!
  handlerUrls = {
    config_schema: tokenized['config_schema'],
    instrument_schemas: tokenized['instrument_schemas'],
  }
}, 120_000)

afterAll(async () => {
  await store?.stop()
})

const priceOf = (id: string): number =>
  [...pool, scarce, ...bulk].find((p) => p.variantId === id)!.priceMinor

function cartRow(token: string) {
  return store.kernel.store.read((tx) => store.kernel.repos.cart.findByToken(tx, token))
}

const lineSet = fc
  .uniqueArray(
    fc.record({ index: fc.nat({ max: POOL - 1 }), quantity: fc.integer({ min: 1, max: 5 }) }),
    { selector: (l) => l.index, minLength: 1, maxLength: 10 },
  )
  .map((ls) => ls.map((l) => ({ variantId: pool[l.index]!.variantId, quantity: l.quantity })))

/** A User-Agent and the agent name its cart's source carries. */
const userAgent = fc.constantFrom(
  ['ChatGPT/2.0 (Macintosh; +https://openai.com/bot)', 'chatgpt'] as const,
  ['Perplexity-Shopper/1.1', 'perplexity-shopper'] as const,
  ['', 'acp'] as const,
)

describe('AC-4: a create opens a session on exactly the agent’s lines at the store’s prices', () => {
  // Kills: lines or quantities drift from the request or the cart; a total that is not the cart's; money leaving minor
  // units; a session that reserves stock or places an order; a source that ignores the agent.
  it('AC-4: property: over generated line sets of up to 10 in-stock variants at quantities 1-5, a create with a buyer and fulfillment_details answers 201 ready_for_payment, valid against CheckoutSession, with the request’s (item, quantity) pairs, the cart’s pairs, store prices and totals, the store currency in lower case, the one tokenized-card handler, the configured links and the cart’s expiry; GET answers it deep-equal; the cart’s source names the User-Agent’s agent; no stock moves and no order is made', async () => {
    await fc.assert(
      fc.asyncProperty(lineSet, userAgent, async (lines, [ua, name]) => {
        const agent = acpClient(store.baseUrl, { userAgent: ua })
        const stocks = lines.map((l) => committedStock(store.kernel.target, l.variantId))
        const orders = committedCount(store.kernel.target, 'orders')

        const created = await agent.create(createBody(lines))
        expect(created.status, JSON.stringify(created.body)).toBe(201)
        const session = created.body
        const row = await cartRow(session.id)
        const read = await agent.get(session.id)
        const cart = await cartOverHttp(store.baseUrl, session.id)
        const lineTotals = session.line_items.map((l) => (l.unit_amount ?? -1) * l.quantity)
        const sum = lineTotals.reduce((a, b) => a + b, 0)

        expect(validateAcp(CHECKOUT_SESSION, session)).toEqual([])
        expect(session.status).toBe('ready_for_payment')
        expect(sessionPairs(session)).toEqual(requestPairs(lines))
        expect(cartPairs(cart)).toEqual(requestPairs(lines))
        for (const line of session.line_items) {
          const seeded = pool.find((p) => p.variantId === line.item.id)!
          expect(line.id).toBe(line.item.id)
          expect(line.name).toBe(`${seeded.productName} – ${seeded.variantName}`)
          expect(line.unit_amount).toBe(seeded.priceMinor)
          expect(line.totals.find((t) => t.type === 'total')?.amount).toBe(
            seeded.priceMinor * line.quantity,
          )
          expect(line.totals.find((t) => t.type === 'subtotal')?.amount).toBe(
            seeded.priceMinor * line.quantity,
          )
        }
        expect(sum).toBe(lines.reduce((s, l) => s + priceOf(l.variantId) * l.quantity, 0))
        expect([
          totalOf(session, 'items_base_amount'),
          totalOf(session, 'subtotal'),
          totalOf(session, 'total'),
          row?.subtotalMinor,
        ]).toEqual([sum, sum, sum, sum])
        expect([totalOf(session, 'tax'), totalOf(session, 'fulfillment')]).toEqual([0, 0])
        expect(session.currency).toBe(store.kernel.config.store.currency.toLowerCase())
        expect(session.capabilities.payment?.handlers).toEqual([
          {
            id: 'card_tokenized',
            name: 'dev.acp.tokenized.card',
            display_name: 'Card',
            version: '2026-01-22',
            spec: 'https://acp.dev/handlers/tokenized.card',
            ...handlerUrls,
            requires_delegate_payment: true,
            requires_pci_compliance: false,
            psp: store.kernel.app.adapters.payments.providerName,
            config: { psp: store.kernel.app.adapters.payments.providerName, environment: 'test' },
          },
        ])
        expect(session.links).toEqual(ACP_LINKS)
        expect(Date.parse(session.expires_at ?? '')).toBe(Date.parse(row?.expiresAt ?? 'none'))
        expect(read.status).toBe(200)
        expect(read.body).toEqual(session)
        expect(await storedCartSource(store.kernel, session.id)).toBe(`agent:${name}`)
        expect(lines.map((l) => committedStock(store.kernel.target, l.variantId))).toEqual(stocks)
        expect(committedCount(store.kernel.target, 'orders')).toBe(orders)
      }),
      {
        numRuns: 15,
        examples: [
          [
            pool.slice(0, 10).map((p, i) => ({ variantId: p.variantId, quantity: (i % 5) + 1 })),
            ['', 'acp'],
          ],
        ],
      },
    )
  }, 240_000)

  // Kills: a session ready for payment with no one to charge or nowhere to ship.
  it('AC-4: a create missing the buyer, the address or both answers not_ready_for_payment with one missing message per absent field, at $.buyer.email and $.fulfillment_details.address; with both it is ready_for_payment with no error message', async () => {
    const agent = acpClient(store.baseUrl)
    const lines: Line[] = [{ variantId: pool[0]!.variantId, quantity: 1 }]
    const seen: Array<{ status: number; state: string; errors: string[]; schema: string[] }> = []
    const wanted: typeof seen = []
    for (const buyer of [true, false]) {
      for (const address of [true, false]) {
        const answer = await agent.create(
          createBody(lines, { ...(!buyer && { email: null }), fulfillment: address }),
        )
        seen.push({
          status: answer.status,
          state: answer.body.status,
          errors: errorMessages(answer.body),
          schema: validateAcp(CHECKOUT_SESSION, answer.body),
        })
        const missing = [
          ...(buyer ? [] : ['missing @ $.buyer.email']),
          ...(address ? [] : ['missing @ $.fulfillment_details.address']),
        ].sort()
        wanted.push({
          status: 201,
          state: missing.length === 0 ? 'ready_for_payment' : 'not_ready_for_payment',
          errors: missing,
          schema: [],
        })
      }
    }

    expect(seen).toEqual(wanted)
  })
})

interface Refused {
  label: string
  body: Record<string, unknown>
  code?: string
  param?: string
}

function refusalOf(answer: AcpAnswer<AcpSession>) {
  return {
    status: answer.status,
    code: answer.body.code,
    param: answer.body.param,
    schema: validateAcp(ACP_ERROR, answer.body),
  }
}

describe('AC-5: a create with any refused line opens no cart', () => {
  // Kills: a refused line dropped and the rest sold; a refusal that still opens a cart; the bounds off by one.
  it('AC-5: an unknown variant (first or second line) → 400 invalid_item_id at its own $.line_items[i].id; more than the stock → 400 out_of_stock; quantity 0 → 400; quantity 100 → 400 quantity_exceeded; 51 distinct ids → 400; a currency not the store’s → 400 invalid at $.currency; each an ACP Error, and the cart count unchanged by all of them', async () => {
    const agent = acpClient(store.baseUrl)
    const good = { variantId: pool[0]!.variantId, quantity: 1 }
    const unknown = randomUUID()
    const cases: Refused[] = [
      {
        label: 'unknown first',
        body: createBody([{ variantId: unknown, quantity: 1 }, good]),
        code: 'invalid_item_id',
        param: '$.line_items[0].id',
      },
      {
        label: 'unknown second',
        body: createBody([good, { variantId: unknown, quantity: 1 }]),
        code: 'invalid_item_id',
        param: '$.line_items[1].id',
      },
      {
        label: 'over stock',
        body: createBody([good, { variantId: scarce.variantId, quantity: scarce.stock + 1 }]),
        code: 'out_of_stock',
        param: '$.line_items[1].id',
      },
      { label: 'quantity 0', body: createBody([{ ...good, quantity: 0 }]) },
      {
        label: 'quantity 100',
        body: createBody([{ variantId: bulk[0]!.variantId, quantity: 100 }]),
        code: 'quantity_exceeded',
        param: '$.line_items[0].id',
      },
      {
        label: '51 distinct ids',
        body: createBody(bulk.map((b) => ({ variantId: b.variantId, quantity: 1 }))),
      },
      {
        label: 'another currency',
        body: createBody([good], { currency: 'usd' }),
        code: 'invalid',
        param: '$.currency',
      },
    ]
    const carts = committedCount(store.kernel.target, 'carts')

    const seen = []
    for (const c of cases) seen.push({ label: c.label, ...refusalOf(await agent.create(c.body)) })
    const cartsAfter = committedCount(store.kernel.target, 'carts')

    expect(
      seen.map((s, i) => ({
        ...s,
        code: cases[i]!.code === undefined ? undefined : s.code,
        param: cases[i]!.param === undefined ? undefined : s.param,
      })),
    ).toEqual(
      cases.map((c) => ({ label: c.label, status: 400, code: c.code, param: c.param, schema: [] })),
    )
    expect(cartsAfter).toBe(carts)
  })

  // Kills: an off-by-one at 50 ids that refuses the largest cart the store allows.
  it('AC-5: 50 distinct ids, one fewer than the bound, answer 201 with 50 lines', async () => {
    const lines = bulk.slice(0, 50).map((b) => ({ variantId: b.variantId, quantity: 1 }))

    const answer = await acpClient(store.baseUrl).create(createBody(lines))

    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    expect(sessionPairs(answer.body)).toEqual(requestPairs(lines))
  })

  // Kills: duplicates double-counted or kept as two lines; an agent setting its own price.
  it('AC-5: two items naming one id become one line at the summed quantity, and an agent’s unit_amount of 1 and its own name are ignored: the line costs the variant’s price', async () => {
    const [a, b] = [pool[1]!, pool[2]!]
    const body = {
      ...createBody([{ variantId: a.variantId, quantity: 1 }]),
      line_items: [
        { id: a.variantId, quantity: 2, unit_amount: 1, name: 'Free lamp' },
        { id: b.variantId, quantity: 1 },
        { id: a.variantId, quantity: 3, unit_amount: 1 },
      ],
    }

    const answer = await acpClient(store.baseUrl).create(body)
    const lineOf = (id: string) => answer.body.line_items?.find((l) => l.item.id === id)

    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    expect(sessionPairs(answer.body)).toEqual(
      requestPairs([
        { variantId: a.variantId, quantity: 5 },
        { variantId: b.variantId, quantity: 1 },
      ]),
    )
    expect(lineOf(a.variantId)?.unit_amount).toBe(a.priceMinor)
    expect(lineOf(a.variantId)?.totals.find((t) => t.type === 'total')?.amount).toBe(
      a.priceMinor * 5,
    )
    expect(totalOf(answer.body, 'total')).toBe(a.priceMinor * 5 + b.priceMinor)
  })

  // Kills: a currency compared case-sensitively, or not compared at all.
  it('AC-5: property: any casing of the store currency is accepted, and any other three-letter code is refused with 400 invalid at $.currency and no cart', async () => {
    const storeCurrency = store.kernel.config.store.currency.toLowerCase()
    const casing = fc
      .array(fc.boolean(), { minLength: 3, maxLength: 3 })
      .map((upper) =>
        [...storeCurrency].map((ch, i) => (upper[i] ? ch.toUpperCase() : ch)).join(''),
      )
    const other = fc
      .stringMatching(/^[a-z]{3}$/)
      .filter((c) => c !== storeCurrency)
      .map((c) => c.toUpperCase())
    await fc.assert(
      fc.asyncProperty(fc.oneof(casing, other), async (currency) => {
        const carts = committedCount(store.kernel.target, 'carts')
        const answer = await acpClient(store.baseUrl).create(
          createBody([{ variantId: pool[3]!.variantId, quantity: 1 }], { currency }),
        )
        const same = currency.toLowerCase() === storeCurrency

        expect(
          same
            ? { status: answer.status, currency: answer.body.currency }
            : { status: answer.status, code: answer.body.code, param: answer.body.param },
        ).toEqual(
          same
            ? { status: 201, currency: storeCurrency }
            : { status: 400, code: 'invalid', param: '$.currency' },
        )
        expect(committedCount(store.kernel.target, 'carts')).toBe(same ? carts + 1 : carts)
      }),
      { numRuns: 20 },
    )
  })
})
