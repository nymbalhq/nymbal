import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { CheckoutQuote } from '@nymbalhq/types'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import { toNymbalAddress } from '../../src/agents/acp/address.js'
import {
  ACP_ADDRESS,
  ACP_ERROR,
  acpClient,
  buyerEmail,
  CHECKOUT_SESSION,
  createBody,
  fulfillmentDetails,
  ordersOfCart,
  recordingPayments,
  seedPool,
  sptPayment,
  totalOf,
  WITH_ORDER,
  withAcp,
  type AcpAnswer,
  type AcpClient,
  type AcpSession,
  type AcpTotal,
  type Line,
  type PoolVariant,
  type RecordingPayments,
} from '../support/acp.js'
import { serveWithAgents, type AgentStore } from '../support/agents.js'
import {
  DEFAULT_GRAMS,
  offeredBy,
  parcelGrams,
  scriptedCarrier,
  withCarrier,
  type ScriptedCarrier,
} from '../support/carrier.js'
import { createKernel } from '../support/kernel.js'
import { both } from '../support/shipping.js'
import { withTax } from '../support/tax.js'

// ACP sessions on a store that prices shipping by its carrier (the kernel's test shipping provider in the `custom`
// slot), served as `nymbal dev` serves them (SQLite): the delivery options an agent is offered are the carrier's, an
// agent's choice is checked against them, complete charges what the agent was last answered, and a carrier that is
// down is a session the agent can retry, never a 500.

const PHONE = '+447700900123'

let store: AgentStore
let agent: AcpClient
let payments: RecordingPayments
let carrier: ScriptedCarrier
let pool: PoolVariant[]

beforeAll(async () => {
  payments = recordingPayments()
  carrier = scriptedCarrier()
  const kernel = await createKernel({
    dialect: 'sqlite',
    configure: both(
      withAcp,
      withTax({ rates: [{ country: 'GB', percent: 20, taxShipping: true }] }),
      withCarrier(),
      (config: NymbalConfig) =>
        ({
          ...config,
          commerce: { ...config.commerce, payments: { provider: 'custom' } },
        }) as NymbalConfig,
    ),
    appOptions: { adapters: { payments: payments.adapter, shipping: carrier.adapter } },
  })
  store = await serveWithAgents(kernel)
  agent = acpClient(store.baseUrl)
  // Neither variant has a weight: each unit weighs the store's default.
  pool = await seedPool(store, [
    { priceMinor: 1_250, stock: 10_000 },
    { priceMinor: 3_499, stock: 10_000 },
  ])
}, 60_000)

afterAll(async () => {
  carrier?.recover()
  await store?.stop()
})

interface FulfillmentOption {
  type: string
  id: string
  title: string
  totals: AcpTotal[]
}

type Session = AcpSession & {
  selected_fulfillment_options?: Array<{ type: string; option_id: string; item_ids: string[] }>
}

type Message = Record<string, unknown>

const lineOf = (i: number, quantity = 1): Line => ({ variantId: pool[i]!.variantId, quantity })

const optionsOf = (session: Session) =>
  (session.fulfillment_options as FulfillmentOption[]).map((o) => ({
    id: o.id,
    title: o.title,
    amount: o.totals.find((t) => t.type === 'total')?.amount,
  }))

const selectedOf = (session: Session) =>
  (session.selected_fulfillment_options ?? []).map((o) => o.option_id)

const totalsOf = (session: Session): Record<string, number> =>
  Object.fromEntries(session.totals.map((t) => [t.type, t.amount]))

/** ACP's totals for checkout totals, as the store maps them. */
function mapped(t: CheckoutQuote['totals']): Record<string, number> {
  return {
    items_base_amount: t.subtotalMinor,
    ...(t.discountTotalMinor > 0 && { discount: t.discountTotalMinor }),
    subtotal: t.subtotalMinor - t.discountTotalMinor,
    fulfillment: t.shippingTotalMinor,
    tax: t.taxTotalMinor,
    total: t.totalMinor,
  }
}

/** The checkout quote for the session's cart at the ACP address and option, from the kernel's own service. */
function quoted(session: Session, shippingOptionId?: string): Promise<CheckoutQuote> {
  return store.kernel.services.checkout.quote({
    cartToken: session.id,
    shippingAddress: toNymbalAddress(ACP_ADDRESS, PHONE),
    ...(shippingOptionId !== undefined && { shippingOptionId }),
  })
}

async function created(lines: readonly Line[], fulfillment = true): Promise<Session> {
  const res = await agent.create(createBody(lines, { email: buyerEmail('carrier'), fulfillment }))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  expect(validateAcp(CHECKOUT_SESSION, res.body)).toEqual([])
  return res.body as Session
}

const selection = (session: Session, optionId: string) => ({
  selected_fulfillment_options: [
    { type: 'shipping', option_id: optionId, item_ids: session.line_items.map((l) => l.id) },
  ],
})

/** The id test-ship's express service has as a checkout option. */
const EXPRESS_ID = 'test_ship-express'

describe('AC-12: an ACP session on a carrier store', () => {
  // Kills: an agent offered the table's options (or the free standard one) on a store that charges the carrier's
  // rates, so the session's total is not what checkout charges.
  it('AC-12: with an address, fulfillment_options, the selection and the totals are the carrier quote’s, and every answer validates', async () => {
    const lines = [lineOf(0, 2), lineOf(1)]
    const fromAnswer = carrier.answers.length
    const session = await created(lines)

    const offers = offeredBy(carrier.answers[fromAnswer] ?? [])
    const grams = parcelGrams([{ weightGrams: null, qty: 3 }])
    expect(offers.map((o) => o.option.amountMinor)).toEqual([
      300 + Math.ceil(grams / 100),
      300 + 2 * Math.ceil(grams / 100),
    ])
    expect(optionsOf(session)).toEqual(
      offers.map((o) => ({ id: o.option.id, title: o.option.name, amount: o.option.amountMinor })),
    )
    const q = await quoted(session)
    expect(selectedOf(session)).toEqual([q.shippingOptionId])
    expect(totalsOf(session)).toEqual(mapped(q.totals))
    const read = await agent.get(session.id)
    expect(validateAcp(CHECKOUT_SESSION, read.body)).toEqual([])
    expect(totalsOf(read.body as Session)).toEqual(totalsOf(session))
  })

  // Kills: a session with no address offered an option at a price no carrier answered.
  it('AC-12: with no address, fulfillment_options is [] and the totals are the cart’s', async () => {
    const session = await created([lineOf(0, 3)], false)

    expect(session.status).toBe('not_ready_for_payment')
    expect(session.fulfillment_options).toEqual([])
    expect(totalOf(session, 'total')).toBe(3 * pool[0]!.priceMinor)
  })

  // Kills: an agent's carrier option refused as unknown, or an option the carrier does not offer kept until payment.
  it('AC-12: update with an offered carrier option_id re-prices the session at it; an option_id not offered answers 400 invalid at its path and leaves the session as it was', async () => {
    const session = await created([lineOf(0)])

    const chose = await agent.update(session.id, selection(session, EXPRESS_ID))

    expect(chose.status, JSON.stringify(chose.body)).toBe(200)
    expect(validateAcp(CHECKOUT_SESSION, chose.body)).toEqual([])
    const body = chose.body as Session
    expect(selectedOf(body)).toEqual([EXPRESS_ID])
    expect(totalsOf(body)).toEqual(mapped((await quoted(body, EXPRESS_ID)).totals))
    expect(totalOf(body, 'fulfillment')).toBe(300 + 2 * Math.ceil(DEFAULT_GRAMS / 100))

    const before = await agent.get(session.id)
    const refused = await agent.update(session.id, selection(session, 'standard'))
    const after = await agent.get(session.id)

    expect({ status: refused.status, code: refused.body.code, param: refused.body.param }).toEqual({
      status: 400,
      code: 'invalid',
      param: '$.selected_fulfillment_options[0].option_id',
    })
    expect(validateAcp(ACP_ERROR, refused.body)).toEqual([])
    expect(after.body).toEqual(before.body)
    expect(selectedOf(after.body as Session)).toEqual([EXPRESS_ID])
  })

  // Kills: the delegated intent for a total other than the one the agent was last answered.
  it('AC-12: complete places the order at the total the last POST answered, the carrier option’s amount as its shipping, and the intent is for that total', async () => {
    const session = await created([lineOf(1, 2)])
    const chose = await agent.update(session.id, selection(session, EXPRESS_ID))
    expect(chose.status, JSON.stringify(chose.body)).toBe(200)
    const total = totalOf(chose.body, 'total')!
    const intentsBefore = payments.intents.length

    const done = await agent.complete(session.id, sptPayment('spt_carrier'))

    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(validateAcp(WITH_ORDER, done.body)).toEqual([])
    const order = await store.kernel.services.order.getById(done.body.order!.id)
    expect(order.totalMinor).toBe(total)
    expect(order.shippingTotalMinor).toBe(totalOf(chose.body, 'fulfillment'))
    expect(payments.intents.slice(intentsBefore).map((i) => i.params.amountMinor)).toEqual([total])
  })

  /** A 200 not_ready_for_payment session with one high, recoverable info message about the delivery price. */
  function expectRetryable(res: AcpAnswer<AcpSession>, what: string): void {
    expect(
      { status: res.status, session: res.body.status },
      `${what}: ${JSON.stringify(res.body)}`,
    ).toEqual({ status: 200, session: 'not_ready_for_payment' })
    expect(validateAcp(CHECKOUT_SESSION, res.body), what).toEqual([])
    const info = ((res.body.messages ?? []) as unknown as Message[]).filter(
      (m) => m['type'] === 'info',
    )
    expect(
      info.map((m) => ({ severity: m['severity'], resolution: m['resolution'] })),
      what,
    ).toEqual([{ severity: 'high', resolution: 'recoverable' }])
    expect(String(info[0]?.['content'] ?? ''), what).toContain('delivery price')
  }

  // Kills: a carrier outage answered 500 (the agent told the store is broken), or a session priced without shipping.
  it('AC-12: with the carrier down, GET, update and complete answer 200 not_ready_for_payment with a recoverable info message naming the delivery price, complete writes no order or intent, and create answers no 500', async () => {
    const session = await created([lineOf(0)])
    const intentsBefore = payments.intents.length
    carrier.fail('throws')
    try {
      const read = await agent.get(session.id)
      // A selection makes the update check the option against the carrier's offer, which is down too.
      const updated = await agent.update(session.id, {
        fulfillment_details: fulfillmentDetails(),
        ...selection(session, EXPRESS_ID),
      })
      const completed = await agent.complete(session.id, sptPayment('spt_down'))
      const fresh = await agent.create(
        createBody([lineOf(1)], { email: buyerEmail('carrier-down') }),
      )

      expectRetryable(read, 'GET')
      expectRetryable(updated, 'update')
      expectRetryable(completed, 'complete')
      expect(ordersOfCart(store.kernel.target, session.id)).toEqual([])
      expect(payments.intents.length).toBe(intentsBefore)
      expect(fresh.status, JSON.stringify(fresh.body)).toBeLessThan(500)
      expect(fresh.body.status).toBe('not_ready_for_payment')
    } finally {
      carrier.recover()
    }
    const recovered = await agent.get(session.id)
    expect(recovered.body.status).toBe('ready_for_payment')
  })
})
