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
  ordersOfCart,
  recordingPayments,
  requestPairs,
  seedPool,
  sptPayment,
  type AcpClient,
  type Line,
  type PoolVariant,
  type RecordingPayments,
} from '../support/acp.js'
import type { AgentStore } from '../support/agents.js'
import { committedCount, committedStock } from '../support/mcp.js'

// AC-9: a declined token, a provider's thrown decline and a 3DS challenge each leave the session ready for another
// try with nothing held: no stock, no pending order, no open intent. A payment_data the store cannot charge is
// refused before any intent.

const POOL = 5

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
    Array.from({ length: POOL }, (_, i) => ({ priceMinor: 2_500 + i * 333, stock: 10_000 })),
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

type Decline = 'declined-email' | 'provider-throws' | 'three-ds'

const MESSAGE: Record<Decline, string> = {
  'declined-email': 'payment_declined',
  'provider-throws': 'payment_declined',
  'three-ds': 'requires_3ds',
}

const confirmedOrders = () => committedCount(store.kernel.target, 'orders', "status = 'confirmed'")
const stocks = (lines: readonly Line[]) =>
  lines.map((l) => committedStock(store.kernel.target, l.variantId))

describe('AC-9: a declined complete holds nothing and the agent can try again', () => {
  // Kills: a decline that holds stock or leaves a pending order; a 3DS intent left open; a session that cannot be
  // paid again after a decline.
  it('AC-9: property: for a stub decline, a provider that throws PaymentError intent_failed, and a 3DS challenge, complete answers 200 ready_for_payment with the one error payment_declined or requires_3ds; stock and the confirmed-order count are unchanged, the draft order is cancelled, the cart keeps its lines, the 3DS intent is cancelled once at the provider; a following complete under a new key with a good email completes and only then does stock fall', async () => {
    await fc.assert(
      fc.asyncProperty(
        lineSet,
        fc.constantFrom<Decline>('declined-email', 'provider-throws', 'three-ds'),
        async (lines, how) => {
          const trigger =
            how === 'declined-email' ? '+stub-decline' : how === 'three-ds' ? '+stub-pending' : ''
          const created = await agent.create(
            createBody(lines, { email: buyerEmail('decline', trigger) }),
          )
          expect(created.status, JSON.stringify(created.body)).toBe(201)
          const id = created.body.id
          const before = stocks(lines)
          const confirmed = confirmedOrders()
          const intentsBefore = payments.intents.length
          const cancelsBefore = payments.cancels.length
          if (how === 'provider-throws') payments.declineNext()

          const declined = await agent.complete(id, sptPayment('spt_declined'))
          const read = await agent.get(id)
          const cart = await cartOverHttp(store.baseUrl, id)
          const drafts = ordersOfCart(store.kernel.target, id)
          const made = payments.intents.slice(intentsBefore)
          const cancelled = payments.cancels.slice(cancelsBefore)

          expect(declined.status, JSON.stringify(declined.body)).toBe(200)
          expect(validateAcp(CHECKOUT_SESSION, declined.body)).toEqual([])
          expect([declined.body.status, read.body.status]).toEqual([
            'ready_for_payment',
            'ready_for_payment',
          ])
          expect(
            declined.body.messages
              .filter((m) => m.type === 'error')
              .map((m) => ({ code: m.code, content_type: m.content_type })),
          ).toEqual([{ code: MESSAGE[how], content_type: 'plain' }])
          expect(stocks(lines)).toEqual(before)
          expect(confirmedOrders()).toBe(confirmed)
          expect(drafts.map((o) => o.status)).toEqual(['cancelled'])
          expect(cartPairs(cart)).toEqual(requestPairs(lines))
          expect(made).toHaveLength(1)
          // A 3DS intent is cancelled at the provider, once; the other outcomes leave nothing open to cancel.
          expect({ how, cancelled: how === 'three-ds' ? cancelled : 'n/a' }).toEqual({
            how,
            cancelled: how === 'three-ds' ? [made[0]!.intentId] : 'n/a',
          })

          const fixed = await agent.update(id, { buyer: { email: buyerEmail('retry') } })
          const paid = await agent.complete(id, sptPayment('spt_good'))

          expect(fixed.body.status).toBe('ready_for_payment')
          expect(paid.status, JSON.stringify(paid.body)).toBe(200)
          expect(paid.body.status).toBe('completed')
          expect(stocks(lines)).toEqual(before.map((s, i) => s - lines[i]!.quantity))
          expect(confirmedOrders()).toBe(confirmed + 1)
        },
      ),
      {
        numRuns: 9,
        examples: [
          [[{ variantId: pool[0]!.variantId, quantity: 2 }], 'declined-email'],
          [[{ variantId: pool[1]!.variantId, quantity: 1 }], 'provider-throws'],
          [[{ variantId: pool[2]!.variantId, quantity: 3 }], 'three-ds'],
        ],
      },
    )
  }, 240_000)

  // Kills: a handler or credential the store cannot charge passed to the provider anyway.
  it('AC-9: property: a payment_data naming any handler but card_tokenized, or any credential type but spt, answers 400 with an ACP Error, makes no intent and moves no stock', async () => {
    const lines: Line[] = [{ variantId: pool[4]!.variantId, quantity: 1 }]
    const created = await agent.create(createBody(lines))
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const id = created.body.id
    const word = fc.stringMatching(/^[a-z][a-z0-9_.-]{0,20}$/)
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          word.filter((h) => h !== 'card_tokenized').map((handler_id) => ({ handler_id })),
          word.filter((t) => t !== 'spt').map((credentialType) => ({ credentialType })),
        ),
        async (wrong) => {
          const before = stocks(lines)
          const intentsBefore = payments.intents.length

          const refused = await agent.complete(id, sptPayment('spt_x', wrong))

          expect({
            status: refused.status,
            schema: validateAcp(ACP_ERROR, refused.body),
          }).toEqual({ status: 400, schema: [] })
          expect(payments.intents.length).toBe(intentsBefore)
          expect(stocks(lines)).toEqual(before)
        },
      ),
      { numRuns: 15 },
    )
  }, 120_000)
})
