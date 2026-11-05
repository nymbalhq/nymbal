import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  ACP_ERROR,
  acpClient,
  acpStore,
  buyerEmail,
  cartOverHttp,
  cartPairs,
  CHECKOUT_SESSION,
  createBody,
  errorMessages,
  fulfillmentDetails,
  requestPairs,
  seedPool,
  sessionPairs,
  takeStockBehindReadModel,
  totalOf,
  type AcpClient,
  type AcpSession,
  type Line,
  type PoolVariant,
} from '../support/acp.js'
import type { AgentStore } from '../support/agents.js'

// AC-6: an update merges the buyer and the fulfillment details, and sets the cart to exactly the lines it names, or
// to nothing new at all: a refused line, before or during the cart calls, leaves the cart and the session as they
// were.

const POOL = 8

let store: AgentStore
let agent: AcpClient
let pool: PoolVariant[]

beforeAll(async () => {
  store = await acpStore()
  agent = acpClient(store.baseUrl)
  pool = await seedPool(
    store,
    Array.from({ length: POOL }, (_, i) => ({ priceMinor: 350 + i * 777, stock: 500 })),
  )
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

const lineSet = fc
  .uniqueArray(
    fc.record({ index: fc.nat({ max: POOL - 1 }), quantity: fc.integer({ min: 1, max: 4 }) }),
    { selector: (l) => l.index, minLength: 1, maxLength: 5 },
  )
  .map((ls) => ls.map((l) => ({ variantId: pool[l.index]!.variantId, quantity: l.quantity })))

const asItems = (lines: readonly Line[]) =>
  lines.map((l) => ({ id: l.variantId, quantity: l.quantity }))

async function opened(lines: readonly Line[], opts: Parameters<typeof createBody>[1] = {}) {
  const created = await agent.create(createBody(lines, opts))
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  return created.body
}

/** The session as GET answers it and the cart as the browser reads it: what a refused update must not move. */
async function state(id: string): Promise<{ session: AcpSession; cart: Array<[string, number]> }> {
  return {
    session: (await agent.get(id)).body,
    cart: cartPairs(await cartOverHttp(store.baseUrl, id)),
  }
}

/** A state with the session's expiry left out and its lines in id order. */
function restored(at: { session: AcpSession; cart: Array<[string, number]> }) {
  const { expires_at: _expiry, ...session } = at.session
  return {
    session: {
      ...session,
      line_items: [...session.line_items].sort((x, y) => x.item.id.localeCompare(y.item.id)),
    },
    cart: at.cart,
  }
}

describe('AC-6: an update merges the buyer and address and replaces the lines, or changes nothing', () => {
  // Kills: an update that replaces the buyer when only the address is sent, or that never re-derives the status.
  it('AC-6: a session created without buyer or address is not_ready_for_payment; an update with the buyer alone keeps it not ready, missing only the address; a second with the address alone makes it ready_for_payment, keeping the buyer; GET agrees', async () => {
    const session = await opened([{ variantId: pool[0]!.variantId, quantity: 1 }], {
      email: null,
      fulfillment: false,
    })
    const email = buyerEmail('merge')

    const withBuyer = await agent.update(session.id, { buyer: { email } })
    const withAddress = await agent.update(session.id, {
      fulfillment_details: fulfillmentDetails(),
    })
    const read = await agent.get(session.id)

    expect([
      session.status,
      withBuyer.body.status,
      withAddress.body.status,
      read.body.status,
    ]).toEqual([
      'not_ready_for_payment',
      'not_ready_for_payment',
      'ready_for_payment',
      'ready_for_payment',
    ])
    expect(errorMessages(withBuyer.body)).toEqual(['missing @ $.fulfillment_details.address'])
    expect(read.body.buyer?.['email']).toBe(email)
    expect(validateAcp(CHECKOUT_SESSION, withAddress.body)).toEqual([])
    expect(read.body).toEqual(withAddress.body)
  })

  // Kills: an update that appends to the cart, or keeps a line the update left out.
  it('AC-6: property: over two generated line sets A and B, after create A and update B the update answers 200 with B’s pairs and B’s total, and GET and the cart hold exactly B', async () => {
    await fc.assert(
      fc.asyncProperty(lineSet, lineSet, async (a, b) => {
        const session = await opened(a)

        const updated = await agent.update(session.id, { line_items: asItems(b) })
        const after = await state(session.id)

        expect(updated.status, JSON.stringify(updated.body)).toBe(200)
        expect(sessionPairs(updated.body)).toEqual(requestPairs(b))
        expect(sessionPairs(after.session)).toEqual(requestPairs(b))
        expect(after.cart).toEqual(requestPairs(b))
        expect(totalOf(updated.body, 'total')).toBe(
          b.reduce(
            (sum, l) =>
              sum + pool.find((p) => p.variantId === l.variantId)!.priceMinor * l.quantity,
            0,
          ),
        )
      }),
      { numRuns: 10 },
    )
  }, 180_000)

  // Kills: a refused update that half-applies its lines.
  it('AC-6: an update whose second line names an unknown variant answers 400 invalid_item_id at $.line_items[1].id, and the session and the cart are deep-equal to before', async () => {
    const session = await opened([{ variantId: pool[0]!.variantId, quantity: 2 }])
    const before = await state(session.id)

    const refused = await agent.update(session.id, {
      line_items: [
        { id: pool[1]!.variantId, quantity: 1 },
        { id: randomUUID(), quantity: 1 },
      ],
    })
    const after = await state(session.id)

    expect({
      status: refused.status,
      code: refused.body.code,
      param: refused.body.param,
      schema: validateAcp(ACP_ERROR, refused.body),
    }).toEqual({ status: 400, code: 'invalid_item_id', param: '$.line_items[1].id', schema: [] })
    expect(after).toEqual(before)
  })

  // Kills: a stock race between the check and the cart calls that leaves the cart with the new lines half added and
  // the old ones gone.
  it('AC-6: when a line’s stock is taken between the check and its cart call, the update answers 400 out_of_stock and the session (less its expiry, lines in id order) and the cart are deep-equal to before', async () => {
    const [raced] = await seedPool(store, [{ priceMinor: 1234, stock: 40 }])
    const session = await opened([
      { variantId: pool[2]!.variantId, quantity: 2 },
      { variantId: pool[3]!.variantId, quantity: 1 },
    ])
    const before = await state(session.id)
    // The read model still shows 40; the command store has none left.
    takeStockBehindReadModel(store.kernel.target, raced!.variantId, 0)

    const refused = await agent.update(session.id, {
      line_items: [
        { id: pool[4]!.variantId, quantity: 1 },
        { id: raced!.variantId, quantity: 2 },
      ],
    })
    const after = await state(session.id)

    expect({ status: refused.status, code: refused.body.code }).toEqual({
      status: 400,
      code: 'out_of_stock',
    })
    // Putting the lines back is a cart change of its own, so the cart's expiry and its line order may move.
    expect(restored(after)).toEqual(restored(before))
  })

  // Kills: an empty update read as "clear the cart"; a fulfillment option the store does not offer accepted.
  it('AC-6: an empty line_items answers 400 invalid at $.line_items and a selected fulfillment option other than standard answers 400, each leaving the session as it was; standard is accepted', async () => {
    const session = await opened([{ variantId: pool[5]!.variantId, quantity: 1 }])
    const before = await state(session.id)
    const option = (optionId: string) => ({
      selected_fulfillment_options: [
        { type: 'shipping', option_id: optionId, item_ids: [pool[5]!.variantId] },
      ],
    })

    const empty = await agent.update(session.id, { line_items: [] })
    const express = await agent.update(session.id, option('express'))
    const afterRefusals = await state(session.id)
    const standard = await agent.update(session.id, option('standard'))

    expect({ status: empty.status, code: empty.body.code, param: empty.body.param }).toEqual({
      status: 400,
      code: 'invalid',
      param: '$.line_items',
    })
    expect(express.status).toBe(400)
    expect(validateAcp(ACP_ERROR, express.body)).toEqual([])
    expect(afterRefusals).toEqual(before)
    expect(standard.status, JSON.stringify(standard.body)).toBe(200)
    expect(sessionPairs(standard.body)).toEqual(before.cart)
  })
})
