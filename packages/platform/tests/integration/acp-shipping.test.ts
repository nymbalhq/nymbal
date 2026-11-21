import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import { toNymbalAddress } from '../../src/agents/acp/address.js'
import {
  ACP_ADDRESS,
  ACP_ERROR,
  acpClient,
  acpStore,
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
  type AcpClient,
  type AcpSession,
  type AcpTotal,
  type Line,
  type PoolVariant,
  type RecordingPayments,
} from '../support/acp.js'
import type { AgentStore } from '../support/agents.js'
import { primedShopper } from '../support/security.js'
import { both, TABLE, withShipping, type QuoteBody } from '../support/shipping.js'
import { withTax, type RateRow } from '../support/tax.js'

// ACP sessions on a store that charges shipping and tax, served as `nymbal dev` serves them (SQLite): what a session
// tells the agent it will cost (the checkout quote, mapped onto ACP's totals), how an agent's choice of delivery is
// taken, and that complete charges the total the agent was last answered, or answers the re-priced session instead.

const TAX_ROWS: RateRow[] = [
  { country: 'GB', percent: 20, taxShipping: true },
  { country: 'DE', percent: 19, taxShipping: true },
]

const PHONE = '+447700900123'
const DE_ADDRESS = {
  ...ACP_ADDRESS,
  line_two: '',
  city: 'Berlin',
  state: 'Berlin',
  country: 'DE',
  postal_code: '10115',
}

interface Shop {
  store: AgentStore
  agent: AcpClient
  payments: RecordingPayments
  pool: PoolVariant[]
  inclusive: boolean
}

async function open(inclusive: boolean): Promise<Shop> {
  const payments = recordingPayments()
  const store = await acpStore({
    payments: payments.adapter,
    configure: both(withTax({ rates: TAX_ROWS, pricesIncludeTax: inclusive }), withShipping(TABLE)),
  })
  const pool = await seedPool(store, [
    { priceMinor: 1_250, stock: 10_000 },
    { priceMinor: 3_499, stock: 10_000 },
  ])
  return { store, agent: acpClient(store.baseUrl), payments, pool, inclusive }
}

/** Tax on top of prices. */
let onTop: Shop
/** Prices include tax. */
let within: Shop

beforeAll(async () => {
  ;[onTop, within] = await Promise.all([open(false), open(true)])
}, 60_000)

afterAll(async () => {
  await onTop?.store.stop()
  await within?.store.stop()
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

const lineOf = (s: Shop, i: number, quantity = 1): Line => ({
  variantId: s.pool[i]!.variantId,
  quantity,
})

/** The session's options as an agent reads them: id, title, and the Shipping amount. */
const optionsOf = (session: Session) =>
  (session.fulfillment_options as FulfillmentOption[]).map((o) => ({
    id: o.id,
    title: o.title,
    amount: o.totals.find((t) => t.type === 'total')?.amount,
  }))

const selectedOf = (session: Session) =>
  (session.selected_fulfillment_options ?? []).map((o) => o.option_id)

/** The session's totals by type. */
const totalsOf = (session: Session): Record<string, number> =>
  Object.fromEntries(session.totals.map((t) => [t.type, t.amount]))

/** ACP's totals for checkout totals, as the store maps them. */
function mapped(t: {
  subtotalMinor: number
  discountTotalMinor: number
  shippingTotalMinor: number
  taxTotalMinor: number
  totalMinor: number
}): Record<string, number> {
  return {
    items_base_amount: t.subtotalMinor,
    ...(t.discountTotalMinor > 0 && { discount: t.discountTotalMinor }),
    subtotal: t.subtotalMinor - t.discountTotalMinor,
    fulfillment: t.shippingTotalMinor,
    tax: t.taxTotalMinor,
    total: t.totalMinor,
  }
}

/** The checkout quote for the session's cart at this ACP address and option, from the kernel's own service. */
async function quoted(
  s: Shop,
  session: Session,
  address: typeof ACP_ADDRESS | typeof DE_ADDRESS,
  shippingOptionId?: string,
): Promise<QuoteBody> {
  return s.store.kernel.services.checkout.quote({
    cartToken: session.id,
    shippingAddress: toNymbalAddress(address, PHONE),
    ...(shippingOptionId !== undefined && { shippingOptionId }),
  })
}

async function created(s: Shop, lines: readonly Line[], fulfillment = true): Promise<Session> {
  const res = await s.agent.create(createBody(lines, { email: buyerEmail('ship'), fulfillment }))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  expect(validateAcp(CHECKOUT_SESSION, res.body)).toEqual([])
  return res.body as Session
}

const selection = (session: Session, optionId: string) => ({
  selected_fulfillment_options: [
    { type: 'shipping', option_id: optionId, item_ids: session.line_items.map((l) => l.id) },
  ],
})

describe('AC-19: a session is priced by the checkout quote', () => {
  // Kills: an agent told shipping and tax are 0 (the free standard option and Σ lines) while checkout charges them;
  // tax on an inclusive store reported as if added on top.
  it('AC-19: with an address on a store with a table, the options, the selection and the totals are the quote’s for that address and its first option, Tax labelled “Tax (included)” when prices include it, and every answer validates', async () => {
    for (const s of [onTop, within]) {
      const session = await created(s, [lineOf(s, 0, 2), lineOf(s, 1)])

      expect(optionsOf(session).map((o) => o.id)).toEqual(['standard', 'express', 'collect'])
      const q = await quoted(s, session, ACP_ADDRESS)
      expect(optionsOf(session)).toEqual(
        q.options.map((o) => ({ id: o.id, title: o.name, amount: o.amountMinor })),
      )
      expect(selectedOf(session)).toEqual([q.shippingOptionId])
      expect(session.selected_fulfillment_options?.[0]?.item_ids.slice().sort()).toEqual(
        session.line_items.map((l) => l.id).sort(),
      )
      expect(totalsOf(session)).toEqual(mapped(q.totals))
      expect(session.totals.find((t) => t.type === 'tax')?.display_text).toBe(
        s.inclusive ? 'Tax (included)' : 'Tax',
      )
      const read = await s.agent.get(session.id)
      expect(validateAcp(CHECKOUT_SESSION, read.body)).toEqual([])
      expect(totalsOf(read.body as Session)).toEqual(totalsOf(session))
    }
  })

  // Kills: a session with no address answered the standard option at 0, which the store may not even offer.
  it('AC-19: with no address on a store with a table, fulfillment_options is [] and the totals are the cart’s', async () => {
    const session = await created(onTop, [lineOf(onTop, 0, 3)], false)
    const sum = 3 * onTop.pool[0]!.priceMinor

    expect(session.status).toBe('not_ready_for_payment')
    expect(session.fulfillment_options).toEqual([])
    expect(totalOf(session, 'total')).toBe(sum)
    expect(totalOf(session, 'items_base_amount')).toBe(sum)
  })
})

describe('AC-20: the agent’s delivery choice', () => {
  // Kills: an agent's choice ignored (the session still priced at the first option).
  it('AC-20: update with an offered option_id re-prices the session at that option', async () => {
    const session = await created(onTop, [lineOf(onTop, 0)])

    const res = await onTop.agent.update(session.id, selection(session, 'express'))

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(validateAcp(CHECKOUT_SESSION, res.body)).toEqual([])
    const body = res.body as Session
    expect(selectedOf(body)).toEqual(['express'])
    expect(totalsOf(body)).toEqual(
      mapped((await quoted(onTop, body, ACP_ADDRESS, 'express')).totals),
    )
    expect(totalOf(body, 'fulfillment')).toBe(999)
  })

  // Kills: an option the store cannot ship to this address kept and refused only at payment, or a refusal that drops
  // the agent's earlier choice.
  it('AC-20: an option_id the quote does not offer answers 400 invalid at its path and leaves the session as it was, its earlier choice kept', async () => {
    const session = await created(onTop, [lineOf(onTop, 0)])
    const chose = await onTop.agent.update(session.id, selection(session, 'express'))
    expect(selectedOf(chose.body as Session)).toEqual(['express'])
    const before = await onTop.agent.get(session.id)

    const res = await onTop.agent.update(session.id, selection(session, 'europe'))
    const after = await onTop.agent.get(session.id)

    expect({ status: res.status, code: res.body.code, param: res.body.param }).toEqual({
      status: 400,
      code: 'invalid',
      param: '$.selected_fulfillment_options[0].option_id',
    })
    expect(validateAcp(ACP_ERROR, res.body)).toEqual([])
    expect(after.body).toEqual(before.body)
    expect(selectedOf(after.body as Session)).toEqual(['express'])
  })

  it('AC-20: a stored selection the new address does not offer is replaced by its first option; an address and an option sent together are checked against the new address', async () => {
    const session = await created(onTop, [lineOf(onTop, 1)])
    const chose = await onTop.agent.update(session.id, selection(session, 'express'))
    expect(selectedOf(chose.body as Session)).toEqual(['express'])

    const moved = await onTop.agent.update(session.id, {
      fulfillment_details: { name: ACP_ADDRESS.name, phone_number: PHONE, address: DE_ADDRESS },
    })

    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    const body = moved.body as Session
    const q = await quoted(onTop, body, DE_ADDRESS)
    expect(optionsOf(body).map((o) => o.id)).toEqual(['europe'])
    expect(selectedOf(body)).toEqual([q.shippingOptionId])
    expect(totalsOf(body)).toEqual(mapped(q.totals))

    const back = await onTop.agent.update(session.id, {
      fulfillment_details: fulfillmentDetails(PHONE),
      ...selection(session, 'collect'),
    })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(selectedOf(back.body as Session)).toEqual(['collect'])
  })
})

/** The cart behind a session, changed over the storefront's cart route, so its total moves without an ACP POST. */
async function addBehindTheAgent(s: Shop, token: string, variantId: string): Promise<void> {
  const shop = await primedShopper(s.store.baseUrl)
  shop.jar.set('nymbal.cart', token)
  const res = await shop.call('POST', '/api/cart/items', { variantId, qty: 1 })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}

describe('AC-21: an agent pays the total it was last answered', () => {
  // Kills: an exclusive-tax store unable to take an ACP order (complete answered 500), or the delegated intent for a
  // total other than the one the agent was shown.
  it('AC-21: unchanged, complete places the order at the session’s total, shipping and tax included, and the delegated intent is for that total', async () => {
    for (const s of [onTop, within]) {
      const session = await created(s, [lineOf(s, 0, 2)])
      const total = totalOf(session, 'total')!
      const intentsBefore = s.payments.intents.length

      const done = await s.agent.complete(session.id, sptPayment('spt_x'))

      expect(done.status, JSON.stringify(done.body)).toBe(200)
      expect(validateAcp(WITH_ORDER, done.body)).toEqual([])
      expect(done.body.status).toBe('completed')
      const order = await s.store.kernel.services.order.getById(done.body.order!.id)
      expect(order.totalMinor).toBe(total)
      expect(order.shippingTotalMinor).toBe(totalOf(session, 'fulfillment'))
      const made = s.payments.intents.slice(intentsBefore)
      expect(made.map((i) => [i.params.amountMinor, i.params.delegatedToken])).toEqual([
        [total, 'spt_x'],
      ])
    }
  })

  // Kills: the buyer charged a total the agent never received.
  it('AC-21: when the total moved since the last POST, complete answers 200 ready_for_payment with a price_change warning for buyer review and the new totals, writing no order or intent; the next complete under a new key charges the new total', async () => {
    const s = onTop
    const session = await created(s, [lineOf(s, 0)])
    const was = totalOf(session, 'total')!
    await addBehindTheAgent(s, session.id, s.pool[1]!.variantId)
    const intentsBefore = s.payments.intents.length

    const refused = await s.agent.complete(session.id, sptPayment('spt_y'))

    expect(refused.status, JSON.stringify(refused.body)).toBe(200)
    expect(validateAcp(CHECKOUT_SESSION, refused.body)).toEqual([])
    const body = refused.body as Session
    expect(body.status).toBe('ready_for_payment')
    const warning = (body.messages as unknown as Array<Record<string, unknown>>).find(
      (m) => m['code'] === 'price_change',
    )
    expect({ type: warning?.['type'], resolution: warning?.['resolution'] }).toEqual({
      type: 'warning',
      resolution: 'requires_buyer_review',
    })
    const now = await quoted(s, body, ACP_ADDRESS)
    expect(totalsOf(body)).toEqual(mapped(now.totals))
    expect(totalOf(body, 'total')).not.toBe(was)
    expect(ordersOfCart(s.store.kernel.target, session.id)).toEqual([])
    expect(s.payments.intents.length).toBe(intentsBefore)

    const again = await s.agent.complete(session.id, sptPayment('spt_y'))

    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.status).toBe('completed')
    const order = await s.store.kernel.services.order.getById(again.body.order!.id)
    expect(order.totalMinor).toBe(now.totals.totalMinor)
    expect(s.payments.intents.slice(intentsBefore).map((i) => i.params.amountMinor)).toEqual([
      now.totals.totalMinor,
    ])
  })
})

describe('AC-23: a session with an order reports what is being charged', () => {
  const columns = (order: {
    subtotalMinor: number
    discountTotalMinor: number
    shippingTotalMinor: number
    taxTotalMinor: number
    totalMinor: number
  }) => mapped(order)

  // Kills: a completed session reporting its lines' sum (no shipping, no tax) instead of what was charged.
  it('AC-23: a completed session’s totals are its order’s columns', async () => {
    const session = await created(onTop, [lineOf(onTop, 1, 2)])
    const done = await onTop.agent.complete(session.id, sptPayment('spt_z'))
    expect(done.status, JSON.stringify(done.body)).toBe(200)

    const read = await onTop.agent.get(session.id)

    const order = await onTop.store.kernel.services.order.getById(done.body.order!.id)
    expect(read.status).toBe(200)
    expect(totalsOf(read.body as Session)).toEqual(columns(order))
    expect(totalsOf(done.body as Session)).toEqual(columns(order))
  })

  // Kills: a session being paid reporting the cart's sum or a fresh re-quote, which the cart has since moved away
  // from, rather than the pending order's columns.
  it('AC-23: a complete_in_progress session’s totals are its pending order’s columns, even after its cart changed', async () => {
    const session = await created(onTop, [lineOf(onTop, 0)])
    const shop = await primedShopper(onTop.store.baseUrl)
    shop.jar.set('nymbal.cart', session.id)
    const shipTo = toNymbalAddress(ACP_ADDRESS, PHONE)
    const placed = await shop.call<{ orderId: string }>('POST', '/api/checkout', {
      email: buyerEmail('pending', '+stub-pending'),
      billingAddress: shipTo,
      shippingAddress: shipTo,
      shippingOptionId: selectedOf(session)[0],
      expectedTotalMinor: totalOf(session, 'total'),
    })
    expect(placed.status, JSON.stringify(placed.body)).toBe(200)
    await addBehindTheAgent(onTop, session.id, onTop.pool[1]!.variantId)

    const read = await onTop.agent.get(session.id)

    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.status).toBe('complete_in_progress')
    const pending = await onTop.store.kernel.services.order.getById(placed.body.data!.orderId)
    expect(totalsOf(read.body as Session)).toEqual(columns(pending))
  })

  // Passes before the change by design: it guards the new quoting from reaching a cancelled session, whose cart was
  // cleared, and turning its read into a 500.
  it('AC-23: a canceled session reads 200 canceled, unquoted', async () => {
    const session = await created(onTop, [lineOf(onTop, 0)])
    const cancelled = await onTop.agent.cancel(session.id)
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)

    const read = await onTop.agent.get(session.id)

    expect({ status: read.status, session: read.body.status }).toEqual({
      status: 200,
      session: 'canceled',
    })
    expect(validateAcp(CHECKOUT_SESSION, read.body)).toEqual([])
  })
})

