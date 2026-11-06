import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  ACP_ADDRESS,
  ACP_ERROR,
  acpClient,
  acpStore,
  buyerEmail,
  cartOverHttp,
  createBody,
  fulfillmentDetails,
  ordersOfCart,
  recordingPayments,
  seedPool,
  sptPayment,
  totalOf,
  WITH_ORDER,
  type AcpAnswer,
  type AcpClient,
  type AcpSession,
  type Line,
  type PoolVariant,
  type RecordingPayments,
} from '../support/acp.js'
import { STOREFRONT, storedCartSource, type AgentStore } from '../support/agents.js'
import { committedStock } from '../support/mcp.js'

// AC-7: complete charges the delegated token once, through the payments adapter, for exactly what the session
// showed, and answers the order the storefront's checkout makes: confirmed, paid, stock committed, the cart emptied,
// with a link that opens it. AC-8: a retry under the same key replays; any number of concurrent completes make one
// order and one intent.

const POOL = 6
const ORDER_KEY_HEADER = 'x-nymbal-order-key'

let store: AgentStore
let agent: AcpClient
let payments: RecordingPayments
let pool: PoolVariant[]

beforeAll(async () => {
  payments = recordingPayments()
  store = await acpStore({ payments: payments.adapter })
  agent = acpClient(store.baseUrl)
  pool = await seedPool(
    store,
    Array.from({ length: POOL }, (_, i) => ({ priceMinor: 1_099 + i * 2_311, stock: 10_000 })),
  )
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

const lineSet = fc
  .uniqueArray(
    fc.record({ index: fc.nat({ max: POOL - 1 }), quantity: fc.integer({ min: 1, max: 3 }) }),
    { selector: (l) => l.index, minLength: 1, maxLength: 3 },
  )
  .map((ls) => ls.map((l) => ({ variantId: pool[l.index]!.variantId, quantity: l.quantity })))

async function readySession(lines: readonly Line[], email = buyerEmail('complete')) {
  const created = await agent.create(createBody(lines, { email }))
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  expect(created.body.status).toBe('ready_for_payment')
  return { session: created.body, email }
}

const stockOf = (id: string) => committedStock(store.kernel.target, id)

describe('AC-7: complete charges the delegated token once and answers the confirmed order', () => {
  // Kills: an order total that differs from what the agent was shown; the token not passed; stock not committed; a
  // cart left full; the session forgetting its order; an order link on the API's origin or with no key.
  it('AC-7: property: over generated line sets, complete with an SPT answers 200 completed valid against CheckoutSessionWithOrder; its order names the session, links <storefront>/order/<number>?key=… which reads the order; the order is confirmed with total = captured = the session total, captured by the provider, the cart’s source and the buyer’s email and address; stock fell by each quantity, the cart is empty, one intent carried the token for the total; a later GET answers the same order with the bare link', async () => {
    await fc.assert(
      fc.asyncProperty(lineSet, async (lines) => {
        const { session, email } = await readySession(lines)
        const total = totalOf(session, 'total')
        const source = await storedCartSource(store.kernel, session.id)
        const before = lines.map((l) => stockOf(l.variantId))
        const intentsBefore = payments.intents.length

        const done = await agent.complete(session.id, sptPayment('spt_x'))
        expect(done.status, JSON.stringify(done.body)).toBe(200)
        expect(validateAcp(WITH_ORDER, done.body)).toEqual([])
        const order = done.body.order!
        const link = new URL(order.permalink_url)
        const key = link.searchParams.get('key') ?? ''
        const keyed = await fetch(
          new URL(`/api/orders/${encodeURIComponent(order.order_number ?? '')}`, store.baseUrl),
          { headers: { accept: 'application/json', [ORDER_KEY_HEADER]: key } },
        )
        const keyedBody = (await keyed.json()) as {
          data?: { orderNumber: string; totalMinor: number }
        }
        const placed = await store.kernel.services.order.getById(order.id)
        const cart = await cartOverHttp(store.baseUrl, session.id)
        const made = payments.intents.slice(intentsBefore)
        const later = await agent.get(session.id)

        expect(done.body.status).toBe('completed')
        expect(order.checkout_session_id).toBe(session.id)
        expect(`${link.origin}${link.pathname}`).toBe(
          `${STOREFRONT}/order/${encodeURIComponent(order.order_number ?? '')}`,
        )
        expect(key).not.toBe('')
        expect({ status: keyed.status, number: keyedBody.data?.orderNumber }).toEqual({
          status: 200,
          number: order.order_number,
        })
        expect(keyedBody.data?.totalMinor).toBe(total)
        expect({
          status: placed.status,
          totalMinor: placed.totalMinor,
          capturedMinor: placed.capturedMinor,
          captureMethod: placed.captureMethod,
          source: placed.source,
          email: placed.email,
        }).toEqual({
          status: 'confirmed',
          totalMinor: total,
          capturedMinor: total,
          captureMethod: 'provider',
          source,
          email,
        })
        expect(placed.shippingAddress).toEqual(
          expect.objectContaining({
            firstName: 'Ada',
            lastName: 'Byron Lovelace',
            addressLine1: ACP_ADDRESS.line_one,
            city: ACP_ADDRESS.city,
            region: ACP_ADDRESS.state,
            postalCode: ACP_ADDRESS.postal_code,
            country: ACP_ADDRESS.country,
            phone: fulfillmentDetails().phone_number,
          }),
        )
        expect(lines.map((l) => stockOf(l.variantId))).toEqual(
          before.map((s, i) => s - lines[i]!.quantity),
        )
        expect(cart.items).toEqual([])
        expect(
          made.map((m) => ({ token: m.params.delegatedToken, amount: m.params.amountMinor })),
        ).toEqual([{ token: 'spt_x', amount: total }])
        expect(later.body.status).toBe('completed')
        expect(later.body.order).toEqual({
          ...order,
          permalink_url: `${STOREFRONT}/order/${encodeURIComponent(order.order_number ?? '')}`,
        })
      }),
      { numRuns: 8 },
    )
  }, 240_000)
})

describe('AC-8: one session, one order, one intent, whatever the retries', () => {
  // Kills: a retry that charges twice; a key reused for another body accepted; a completed session paid again.
  it('AC-8: the same complete under its key replays the same status and body with Idempotent-Replayed: true; the key with another body answers 422 idempotency_conflict; another key on the completed session answers 405 session_closed; one order and one intent throughout', async () => {
    const { session } = await readySession([{ variantId: pool[0]!.variantId, quantity: 2 }])
    const key = `acp-replay-${session.id}`
    const intentsBefore = payments.intents.length

    const first = await agent.complete(session.id, sptPayment('spt_x'), { 'idempotency-key': key })
    const replay = await agent.complete(session.id, sptPayment('spt_x'), { 'idempotency-key': key })
    const conflict = await agent.complete(session.id, sptPayment('spt_other'), {
      'idempotency-key': key,
    })
    const again = await agent.complete(session.id, sptPayment('spt_x'))

    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.status).toBe('completed')
    expect({ status: replay.status, body: replay.body }).toEqual({
      status: first.status,
      body: first.body,
    })
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect({
      status: conflict.status,
      code: conflict.body.code,
      schema: validateAcp(ACP_ERROR, conflict.body),
    }).toEqual({ status: 422, code: 'idempotency_conflict', schema: [] })
    expect({ status: again.status, code: again.body.code }).toEqual({
      status: 405,
      code: 'session_closed',
    })
    expect(payments.intents.length - intentsBefore).toBe(1)
    expect(ordersOfCart(store.kernel.target, session.id)).toHaveLength(1)
  })

  // Kills: a concurrent pair that makes two orders or two intents, or a loser that answers 5xx.
  it('AC-8: property: k ∈ 2..5 concurrent completes under distinct keys make exactly one confirmed order and one createPaymentIntent; one answers 200 completed and each other 409 idempotency_in_flight with Retry-After: 1, 405 session_closed or 200 complete_in_progress, none 5xx', async () => {
    await fc.assert(
      fc.asyncProperty(lineSet, fc.integer({ min: 2, max: 5 }), async (lines, k) => {
        const { session } = await readySession(lines)
        const intentsBefore = payments.intents.length

        const answers: Array<AcpAnswer<AcpSession>> = await Promise.all(
          Array.from({ length: k }, () => agent.complete(session.id, sptPayment('spt_x'))),
        )
        const kinds = answers.map((a) =>
          a.status === 200
            ? `200 ${a.body.status}`
            : a.status === 409
              ? `409 ${a.body.code} retry-after ${a.headers.get('retry-after')}`
              : `${a.status} ${a.body.code}`,
        )
        const orders = ordersOfCart(store.kernel.target, session.id)

        expect(kinds.filter((x) => x === '200 completed')).toHaveLength(1)
        for (const kind of kinds.filter((x) => x !== '200 completed')) {
          expect([
            '409 idempotency_in_flight retry-after 1',
            '405 session_closed',
            '200 complete_in_progress',
          ]).toContain(kind)
        }
        expect(answers.filter((a) => a.status >= 500)).toEqual([])
        expect(orders.filter((o) => o.status === 'confirmed')).toHaveLength(1)
        expect(payments.intents.length - intentsBefore).toBe(1)
      }),
      { numRuns: 8 },
    )
  }, 240_000)
})
