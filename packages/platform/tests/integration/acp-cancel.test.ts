import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  ACP_ERROR,
  acpClient,
  acpStore,
  cartOverHttp,
  CHECKOUT_SESSION,
  createBody,
  ordersOfCart,
  seedPool,
  sptPayment,
  type AcpClient,
  type Line,
  type PoolVariant,
} from '../support/acp.js'
import type { AgentStore } from '../support/agents.js'
import { committedStock } from '../support/mcp.js'
import { primedShopper } from '../support/security.js'

// AC-10: cancel is an explicit mark that closes the session for good and empties its cart; it never touches an
// order. A cart emptied some other way is not a cancelled session.

let store: AgentStore
let agent: AcpClient
let pool: PoolVariant[]

beforeAll(async () => {
  store = await acpStore()
  agent = acpClient(store.baseUrl)
  pool = await seedPool(store, [
    { priceMinor: 3_100, stock: 100 },
    { priceMinor: 875, stock: 100 },
  ])
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

async function opened(lines: readonly Line[]) {
  const created = await agent.create(createBody(lines))
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  return created.body
}

const stockOf = (id: string) => committedStock(store.kernel.target, id)

function closed(answer: { status: number; body: { code?: string } }) {
  return {
    status: answer.status,
    code: answer.body.code,
    schema: validateAcp(ACP_ERROR, answer.body),
  }
}

const SESSION_CLOSED = { status: 405, code: 'session_closed', schema: [] }

describe('AC-10: cancel closes a session and empties its cart, never touching an order', () => {
  // Kills: a cancelled session that can still be updated or paid; cancel that leaves the cart's lines.
  it('AC-10: cancel answers 200 canceled with the cart empty and the session document’s canceledAt set; GET reads canceled; cancel again, update and complete each answer 405 session_closed; no order and no stock change come of it', async () => {
    const lines: Line[] = [
      { variantId: pool[0]!.variantId, quantity: 2 },
      { variantId: pool[1]!.variantId, quantity: 1 },
    ]
    const stocks = lines.map((l) => stockOf(l.variantId))
    const session = await opened(lines)
    const at = Date.now()

    const cancelled = await agent.cancel(session.id)
    const after = Date.now()
    const cart = await cartOverHttp(store.baseUrl, session.id)
    const document = await store.kernel.documentStore.get<{ canceledAt?: string }>(
      'acp_sessions',
      session.id,
    )
    const read = await agent.get(session.id)
    const again = await agent.cancel(session.id)
    const update = await agent.update(session.id, {
      line_items: [{ id: pool[0]!.variantId, quantity: 1 }],
    })
    const complete = await agent.complete(session.id, sptPayment('spt_x'))
    const markedAt = Date.parse(document?.canceledAt ?? '')

    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect(validateAcp(CHECKOUT_SESSION, cancelled.body)).toEqual([])
    expect([cancelled.body.status, read.body.status]).toEqual(['canceled', 'canceled'])
    expect(cart.items).toEqual([])
    expect(markedAt).toBeGreaterThanOrEqual(at - 1_000)
    expect(markedAt).toBeLessThanOrEqual(after + 1_000)
    expect([closed(again), closed(update), closed(complete)]).toEqual([
      SESSION_CLOSED,
      SESSION_CLOSED,
      SESSION_CLOSED,
    ])
    expect(ordersOfCart(store.kernel.target, session.id)).toEqual([])
    expect(lines.map((l) => stockOf(l.variantId))).toEqual(stocks)
  })

  // Kills: canceled derived from "the cart has no lines" rather than from the explicit mark.
  it('AC-10: a live session whose cart the browser empties (DELETE /api/cart with its cookie) has no lines and does not read canceled', async () => {
    const session = await opened([{ variantId: pool[0]!.variantId, quantity: 1 }])
    const shop = await primedShopper(store.baseUrl, new Map([['nymbal.cart', session.id]]))

    const emptied = await shop.call('DELETE', '/api/cart')
    const read = await agent.get(session.id)

    expect(emptied.status, JSON.stringify(emptied.body)).toBe(200)
    expect(read.status).toBe(200)
    expect(read.body.line_items).toEqual([])
    expect(read.body.status).not.toBe('canceled')
    expect(read.body.status).toBe(session.status)
  })

  // Kills: cancel that refunds, cancels or otherwise touches a paid order.
  it('AC-10: cancel on a completed session answers 405 session_closed, the order is deep-equal to before and GET still reads completed', async () => {
    const session = await opened([{ variantId: pool[1]!.variantId, quantity: 3 }])
    const done = await agent.complete(session.id, sptPayment('spt_x'))
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    const orderId = done.body.order!.id
    const before = await store.kernel.services.order.getById(orderId)

    const refused = await agent.cancel(session.id)
    const after = await store.kernel.services.order.getById(orderId)
    const read = await agent.get(session.id)

    expect(closed(refused)).toEqual(SESSION_CLOSED)
    expect(after).toEqual(before)
    expect(read.body.status).toBe('completed')
  })
})
