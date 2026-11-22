import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  ACP_ERROR,
  acpClient,
  acpStore,
  buyerEmail,
  CHECKOUT_SESSION,
  createBody,
  fulfillmentDetails,
  recordingPayments,
  seedPool,
  sptPayment,
  totalOf,
  WITH_ORDER,
  withAcp,
  type AcpAnswer,
  type AcpClient,
  type AcpSession,
  type Line,
  type PoolVariant,
} from '../support/acp.js'
import { serveWithAgents, type AgentStore } from '../support/agents.js'
import { createKernel } from '../support/kernel.js'
import { committedCount } from '../support/mcp.js'
import {
  scriptedEngine,
  seedPromotion,
  uniqueCode,
  type PricedCart,
  type ScriptedEngine,
} from '../support/promotions.js'

// Discount codes on ACP sessions, served as `nymbal dev` serves them (SQLite): `discounts.codes` (and the deprecated
// `coupons`) reach the cart through the code tools, every session answers the pinned `discounts` block from the cart's
// codes and the totals it shows, and `complete` charges the discounted total the agent was last answered. The native
// engine prices the codes; a scripted engine in the `custom` slot stands in for one that is down.

interface Applied {
  id: string
  code?: string
  coupon: { id: string; name: string }
  amount: number
}

interface Rejected {
  code: string
  reason: string
  message?: string
}

type Session = AcpSession & {
  discounts?: { codes?: string[]; applied?: Applied[]; rejected?: Rejected[] }
  capabilities: AcpSession['capabilities'] & {
    extensions?: Array<{ name: string; extends?: string[] }>
  }
}

type Message = Record<string, unknown>

const DISCOUNT_EXTENSION = { name: 'discount', extends: ['$.CheckoutSession.discounts'] }
const CODES_DOWN =
  'The discount codes could not be checked just now. Send discounts.codes again in an update shortly.'
const EXPIRED_MESSAGE = 'This code has expired.'

let store: AgentStore
let agent: AcpClient
let pool: PoolVariant[]
/** A 10% code, stored in upper case. */
let ten: string
/** £3 off, stored in upper case. */
let fixed: string
/** A 10% code that expired yesterday. */
let expired: string

beforeAll(async () => {
  store = await acpStore({ payments: recordingPayments().adapter })
  agent = acpClient(store.baseUrl)
  pool = await seedPool(store, [
    { priceMinor: 2_499, stock: 10_000 },
    { priceMinor: 1_150, stock: 10_000 },
  ])
  ten = uniqueCode('TEN').toUpperCase()
  fixed = uniqueCode('FIXED').toUpperCase()
  expired = uniqueCode('GONE').toUpperCase()
  await seedPromotion(store.kernel, { code: ten, kind: 'percent', percentBps: 1_000 })
  await seedPromotion(store.kernel, {
    code: fixed,
    kind: 'fixed',
    amountOffMinor: 300,
    currency: 'GBP',
  })
  await seedPromotion(store.kernel, {
    code: expired,
    kind: 'percent',
    percentBps: 1_000,
    expiresAt: new Date(Date.now() - 86_400_000),
  })
}, 120_000)

afterAll(async () => {
  await store?.stop()
})

// ─── Reading what a session left ───────────────────────────────────────────

/** `GET /api/cart` as the browser holding the session's cart cookie reads it: the cart, its totals and its codes. */
async function pricedCart(baseUrl: string, token: string): Promise<PricedCart> {
  const res = await fetch(new URL('/api/cart', baseUrl), {
    headers: { accept: 'application/json', cookie: `nymbal.cart=${token}` },
  })
  const body = (await res.json()) as { data?: PricedCart }
  if (res.status !== 200 || body.data === undefined)
    throw new Error(`GET /api/cart: ${res.status} ${JSON.stringify(body)}`)
  return body.data
}

const cartCodes = (cart: PricedCart): string[] => cart.promotions.codes.map((c) => c.code)
const messagesOf = (session: Session): Message[] => (session.messages ?? []) as unknown as Message[]
const ofType = (session: Session, type: string): Message[] =>
  messagesOf(session).filter((m) => m['type'] === type)
const discountOf = (session: Session): number => totalOf(session, 'discount') ?? 0

function answered(res: AcpAnswer<AcpSession>, status: number, what: string): Session {
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(status)
  return res.body as Session
}

/** The totals a priced session shows add up: items − discount = subtotal; subtotal + fulfillment + tax = total. */
function expectTotalsAddUp(session: Session, what: string): void {
  const base = totalOf(session, 'items_base_amount')!
  const subtotal = totalOf(session, 'subtotal')!
  expect(subtotal, `${what}: subtotal`).toBe(base - discountOf(session))
  expect(totalOf(session, 'total'), `${what}: total`).toBe(
    subtotal + (totalOf(session, 'fulfillment') ?? 0) + (totalOf(session, 'tax') ?? 0),
  )
}

const line = (i: number, quantity = 1): Line => ({ variantId: pool[i]!.variantId, quantity })

function withCodes(
  body: Record<string, unknown>,
  codes: { discounts?: string[]; coupons?: string[] },
): Record<string, unknown> {
  return {
    ...body,
    ...(codes.discounts !== undefined && { discounts: { codes: codes.discounts } }),
    ...(codes.coupons !== undefined && { coupons: codes.coupons }),
  }
}

const lineSet = fc
  .uniqueArray(fc.record({ index: fc.nat({ max: 1 }), quantity: fc.integer({ min: 1, max: 3 }) }), {
    selector: (l) => l.index,
    minLength: 1,
    maxLength: 2,
  })
  .map((ls) => ls.map((l) => line(l.index, l.quantity)))

const casing = fc.constantFrom<(code: string) => string>(
  (c) => c.toLowerCase(),
  (c) => c.toUpperCase(),
  (c) => c.slice(0, 3).toLowerCase() + c.slice(3),
)

// ─── AC-6 ───────────────────────────────────────────────────────────────────

describe('AC-6: a create with a code is priced with it, and complete charges that', () => {
  // Kills: the codes still ignored; a session showing a total the order does not charge; a discounts block or
  // extension that breaks the pinned schema.
  it('AC-6: property: a create with discounts.codes [a 10% code in any case], a buyer and an address answers 201 ready_for_payment, valid, with discount = the cart’s totals.discountTotalMinor = ⌊subtotal / 10⌋, totals that add up, discounts { codes: [the code], one applied entry at the discount, rejected: [] }, no warning and the discount extension; complete places an order with that discount and total', async () => {
    await fc.assert(
      fc.asyncProperty(lineSet, casing, async (lines, cased) => {
        const code = cased(ten)
        const session = answered(
          await agent.create(withCodes(createBody(lines), { discounts: [code] })),
          201,
          'create',
        )
        const cart = await pricedCart(store.baseUrl, session.id)
        const discount = discountOf(session)

        expect(session.status).toBe('ready_for_payment')
        expect(validateAcp(CHECKOUT_SESSION, session)).toEqual([])
        expect(cartCodes(cart)).toEqual([code])
        expect([discount, cart.totals.discountTotalMinor]).toEqual([
          Math.floor(cart.subtotalMinor / 10),
          Math.floor(cart.subtotalMinor / 10),
        ])
        expect(totalOf(session, 'items_base_amount')).toBe(cart.subtotalMinor)
        expectTotalsAddUp(session, 'create')
        expect(session.discounts?.codes).toEqual([code])
        expect(
          (session.discounts?.applied ?? []).map((a) => ({
            code: (a.code ?? a.id).toLowerCase(),
            amount: a.amount,
          })),
        ).toEqual([{ code: code.toLowerCase(), amount: discount }])
        expect(session.discounts?.rejected).toEqual([])
        expect(ofType(session, 'warning')).toEqual([])
        expect(session.capabilities.extensions).toContainEqual(DISCOUNT_EXTENSION)

        const done = answered(
          await agent.complete(session.id, sptPayment('spt_codes')),
          200,
          'complete',
        )
        expect(validateAcp(WITH_ORDER, done)).toEqual([])
        const order = await store.kernel.services.order.getById(done.order!.id)
        expect({ discount: order.discountTotalMinor, total: order.totalMinor }).toEqual({
          discount,
          total: totalOf(session, 'total'),
        })
      }),
      { numRuns: 4 },
    )
  }, 120_000)
})

// ─── AC-7 ───────────────────────────────────────────────────────────────────

describe('AC-7: an update’s discounts.codes replaces the cart’s codes', () => {
  // Kills: an update that appends instead of replacing, an empty list that clears nothing, an absent field that clears
  // the codes, or a complete that charges a total from before the codes changed (the stored quote not rewritten).
  it('AC-7: [ten] → update [fixed] → update without discounts → update [] → update [ten]: after each the cart holds exactly the codes asked for (kept when the field is absent), the session’s discount, total and discounts.codes are the cart’s, and complete charges the total and discount the last update answered', async () => {
    const created = answered(
      await agent.create(
        withCodes(createBody([line(0, 2), line(1)]), { discounts: [ten.toLowerCase()] }),
      ),
      201,
      'create',
    )
    const steps: Array<{ what: string; body: Record<string, unknown>; codes: string[] }> = [
      { what: 'replace', body: { discounts: { codes: [fixed] } }, codes: [fixed] },
      { what: 'absent', body: { fulfillment_details: fulfillmentDetails() }, codes: [fixed] },
      { what: 'clear', body: { discounts: { codes: [] } }, codes: [] },
      { what: 'again', body: { discounts: { codes: [ten] } }, codes: [ten] },
    ]
    let last = created
    for (const step of steps) {
      last = answered(await agent.update(created.id, step.body), 200, step.what)
      const cart = await pricedCart(store.baseUrl, created.id)

      expect(validateAcp(CHECKOUT_SESSION, last), step.what).toEqual([])
      expect(cartCodes(cart), `${step.what}: the cart's codes`).toEqual(step.codes)
      expect(last.discounts?.codes ?? [], `${step.what}: discounts.codes`).toEqual(step.codes)
      expect(
        { discount: discountOf(last), total: totalOf(last, 'total') },
        `${step.what}: the session's money`,
      ).toEqual({ discount: cart.totals.discountTotalMinor, total: cart.totals.totalMinor })
      expectTotalsAddUp(last, step.what)
    }
    expect(discountOf(last)).toBeGreaterThan(0)

    const done = answered(await agent.complete(created.id, sptPayment('spt_replace')), 200, 'done')
    const order = await store.kernel.services.order.getById(done.order!.id)
    expect({ discount: order.discountTotalMinor, total: order.totalMinor }).toEqual({
      discount: discountOf(last),
      total: totalOf(last, 'total'),
    })
  }, 60_000)
})

// ─── AC-8 ───────────────────────────────────────────────────────────────────

describe('AC-8: a refused code is told to the agent and does not block payment', () => {
  // Kills: an expired code that silently vanishes, discounts anyway, blocks payment, or is reported with a reason or a
  // message shape outside the pinned schema; a warning raised for a code that was accepted.
  it('AC-8: a session with an expired code stays undiscounted and ready_for_payment, lists the code in rejected as discount_code_expired with the storefront message, carries one warning for it at $.discounts.codes[0] and validates; an accepted code adds no warning', async () => {
    const refused = answered(
      await agent.create(withCodes(createBody([line(0)]), { discounts: [expired] })),
      201,
      'expired',
    )
    const accepted = answered(
      await agent.create(withCodes(createBody([line(0)]), { discounts: [ten] })),
      201,
      'accepted',
    )

    expect(validateAcp(CHECKOUT_SESSION, refused)).toEqual([])
    expect(refused.status).toBe('ready_for_payment')
    expect(discountOf(refused)).toBe(0)
    expect(totalOf(refused, 'total')).toBe(totalOf(refused, 'items_base_amount'))
    expect(refused.discounts?.codes).toEqual([expired])
    expect(refused.discounts?.applied).toEqual([])
    expect(refused.discounts?.rejected).toEqual([
      { code: expired, reason: 'discount_code_expired', message: EXPIRED_MESSAGE },
    ])
    expect(ofType(refused, 'warning')).toEqual([
      {
        type: 'warning',
        code: 'discount_code_expired',
        severity: 'medium',
        resolution: 'requires_buyer_input',
        param: '$.discounts.codes[0]',
        content_type: 'plain',
        content: EXPIRED_MESSAGE,
      },
    ])
    expect(accepted.status).toBe('ready_for_payment')
    expect(discountOf(accepted)).toBeGreaterThan(0)
    expect(ofType(accepted, 'warning')).toEqual([])
  })
})

// ─── AC-9 ───────────────────────────────────────────────────────────────────

function refusalOf(res: AcpAnswer<AcpSession>) {
  return {
    status: res.status,
    code: res.body.code,
    param: res.body.param,
    schema: validateAcp(ACP_ERROR, res.body),
  }
}

const refusedAt = (param: string) => ({ status: 400, code: 'invalid', param, schema: [] })

describe('AC-9: the codes an agent sends are checked before anything changes', () => {
  // Kills: an agent's sixth code half-applying the list, or a list refused only after the cart took part of it.
  it('AC-9: more than five distinct codes (case-insensitive) is 400 invalid at $.discounts.codes, or at $.coupons when they came in coupons, on create (no cart opened) and on update (the cart’s codes unchanged); five distinct among six spellings is accepted', async () => {
    const six = Array.from({ length: 6 }, (_, i) => `${ten}-${i}`)
    const carts = committedCount(store.kernel.target, 'carts')

    const viaDiscounts = await agent.create(withCodes(createBody([line(0)]), { discounts: six }))
    const viaCoupons = await agent.create(withCodes(createBody([line(0)]), { coupons: six }))
    expect(committedCount(store.kernel.target, 'carts')).toBe(carts)
    expect([refusalOf(viaDiscounts), refusalOf(viaCoupons)]).toEqual([
      refusedAt('$.discounts.codes'),
      refusedAt('$.coupons'),
    ])

    const session = answered(
      await agent.create(withCodes(createBody([line(0)]), { discounts: [ten] })),
      201,
      'create',
    )
    const update = await agent.update(session.id, { discounts: { codes: six } })
    expect(refusalOf(update)).toEqual(refusedAt('$.discounts.codes'))
    expect(cartCodes(await pricedCart(store.baseUrl, session.id))).toEqual([ten])

    const fiveDistinct = [ten, ten.toLowerCase(), 'b-code', 'c-code', 'd-code', 'e-code']
    const allowed = await agent.update(session.id, { discounts: { codes: fiveDistinct } })
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200)
  }, 60_000)

  // Kills: a code no browser could remove (`.`, `..`) or one the cart would refuse reaching the cart, or a refusal that
  // does not say which code it was.
  it('AC-9: an empty, a 65-character, a "." or a ".." code (padded too) is 400 invalid at its own index in discounts.codes or coupons, on create (no cart opened) and on update (the cart’s codes unchanged)', async () => {
    const bad = ['', ' ', 'x'.repeat(65), '.', '..', ' .. ']
    const carts = committedCount(store.kernel.target, 'carts')
    const seen = []
    for (const code of bad) {
      seen.push(
        refusalOf(await agent.create(withCodes(createBody([line(0)]), { discounts: [ten, code] }))),
        refusalOf(await agent.create(withCodes(createBody([line(0)]), { coupons: [ten, code] }))),
      )
    }
    expect(committedCount(store.kernel.target, 'carts')).toBe(carts)
    expect(seen).toEqual(
      bad.flatMap(() => [refusedAt('$.discounts.codes[1]'), refusedAt('$.coupons[1]')]),
    )

    const session = answered(
      await agent.create(withCodes(createBody([line(0)]), { discounts: [fixed] })),
      201,
      'create',
    )
    const updates = []
    for (const code of bad) {
      updates.push(refusalOf(await agent.update(session.id, { discounts: { codes: [code] } })))
    }
    expect(updates).toEqual(bad.map(() => refusedAt('$.discounts.codes[0]')))
    expect(cartCodes(await pricedCart(store.baseUrl, session.id))).toEqual([fixed])
  }, 60_000)

  // Kills: an agent on the deprecated field charged full price, or a request carrying both fields priced by the
  // deprecated one.
  it('AC-9: coupons alone applies the code as discounts.codes does (the cart’s discount and total); with both fields, discounts.codes is the list used', async () => {
    const viaCoupons = answered(
      await agent.create(withCodes(createBody([line(0, 2)]), { coupons: [ten.toLowerCase()] })),
      201,
      'coupons',
    )
    const couponsCart = await pricedCart(store.baseUrl, viaCoupons.id)
    expect(cartCodes(couponsCart)).toEqual([ten.toLowerCase()])
    expect(viaCoupons.discounts?.codes).toEqual([ten.toLowerCase()])
    expect({ discount: discountOf(viaCoupons), total: totalOf(viaCoupons, 'total') }).toEqual({
      discount: couponsCart.totals.discountTotalMinor,
      total: couponsCart.totals.totalMinor,
    })
    expect(discountOf(viaCoupons)).toBe(Math.floor(couponsCart.subtotalMinor / 10))

    const both = answered(
      await agent.create(
        withCodes(createBody([line(0, 2)]), { discounts: [fixed], coupons: [ten] }),
      ),
      201,
      'both',
    )
    const bothCart = await pricedCart(store.baseUrl, both.id)
    expect(cartCodes(bothCart)).toEqual([fixed])
    expect(both.discounts?.codes).toEqual([fixed])
    expect(discountOf(both)).toBe(bothCart.totals.discountTotalMinor)
    expect(bothCart.totals.discountTotalMinor).toBe(300)
  }, 60_000)
})

// ─── AC-10 ──────────────────────────────────────────────────────────────────

let downStore:
  | Promise<{ store: AgentStore; agent: AcpClient; engine: ScriptedEngine; pool: PoolVariant[] }>
  | undefined

/** A store whose promotions engine a test scripts (it accepts the first code at 10% until it fails). */
function withScriptedEngine() {
  downStore ??= (async () => {
    const engine = scriptedEngine()
    const kernel = await createKernel({
      dialect: 'sqlite',
      configure: (config: NymbalConfig) => {
        const on = withAcp(config)
        return {
          ...on,
          commerce: {
            ...on.commerce,
            promotions: { provider: 'custom', onUnavailable: 'proceed' },
          },
        } as NymbalConfig
      },
      appOptions: { adapters: { promotions: engine.adapter } },
    })
    const served = await serveWithAgents(kernel)
    const seeded = await seedPool(served, [{ priceMinor: 1_800, stock: 10_000 }])
    return { store: served, agent: acpClient(served.baseUrl), engine, pool: seeded }
  })()
  return downStore
}

afterAll(async () => {
  const built = await downStore?.catch(() => undefined)
  built?.engine.recover()
  await built?.store.stop()
})

function expectCodesDown(session: Session, code: string, what: string): void {
  expect(session.status, what).toBe('not_ready_for_payment')
  expect(validateAcp(CHECKOUT_SESSION, session), what).toEqual([])
  expect(
    ofType(session, 'info').map((m) => ({
      severity: m['severity'],
      resolution: m['resolution'],
      content: m['content'],
    })),
    `${what}: the info messages`,
  ).toEqual([{ severity: 'high', resolution: 'recoverable', content: CODES_DOWN }])
  expect(session.discounts?.codes ?? [], `${what}: discounts.codes`).not.toContain(code)
}

describe('AC-10: a code sent while the promotions engine is down', () => {
  // Kills: an engine outage that turns the agent's request into a 500, or a session that claims a code the cart never
  // took.
  it('AC-10: a create carrying a code answers 201 not_ready_for_payment with exactly one recoverable info message telling the agent to send discounts.codes again, and neither the session nor the cart holds the code', async () => {
    const s = await withScriptedEngine()
    const code = uniqueCode('DOWN')
    s.engine.fail()
    try {
      const res = await s.agent.create(
        withCodes(createBody([{ variantId: s.pool[0]!.variantId, quantity: 1 }]), {
          discounts: [code],
        }),
      )
      const session = answered(res, 201, 'create')
      expectCodesDown(session, code, 'create')
      expect(cartCodes(await pricedCart(s.store.baseUrl, session.id))).toEqual([])
    } finally {
      s.engine.recover()
    }
  }, 60_000)

  // Kills: two messages telling the agent two different things to retry (the quote's promotions message beside the
  // codes'), or an outage that throws away the update's other changes.
  it('AC-10: an update adding a code to a cart that already holds one answers 200 not_ready_for_payment with that one info message alone, the new code absent from discounts.codes, and the update’s line change standing', async () => {
    const s = await withScriptedEngine()
    const kept = uniqueCode('KEPT')
    const added = uniqueCode('ADDED')
    const variantId = s.pool[0]!.variantId
    const created = answered(
      await s.agent.create(
        withCodes(createBody([{ variantId, quantity: 1 }]), { discounts: [kept] }),
      ),
      201,
      'create',
    )
    expect(created.discounts?.codes).toEqual([kept])
    s.engine.fail()
    try {
      const res = await s.agent.update(created.id, {
        line_items: [{ id: variantId, quantity: 2 }],
        discounts: { codes: [kept, added] },
      })
      const session = answered(res, 200, 'update')
      expectCodesDown(session, added, 'update')
      const cart = await pricedCart(s.store.baseUrl, created.id)
      expect(cart.items.map((i) => [i.variantId, i.qty])).toEqual([[variantId, 2]])
      expect(cartCodes(cart)).not.toContain(added)
    } finally {
      s.engine.recover()
    }
  }, 60_000)
})

// ─── AC-11 ──────────────────────────────────────────────────────────────────

describe('AC-11: the discount shows before an address and after the order', () => {
  // Kills: an agent shown the undiscounted sum until an address is given.
  it('AC-11: a session with a code and no address shows discount = the cart’s totals.discountTotalMinor and total = its totals.totalMinor, items at the subtotal and subtotal = items − discount', async () => {
    const session = answered(
      await agent.create(
        withCodes(createBody([line(0, 3)], { fulfillment: false }), { discounts: [ten] }),
      ),
      201,
      'create',
    )
    const cart = await pricedCart(store.baseUrl, session.id)

    expect(session.status).toBe('not_ready_for_payment')
    expect(validateAcp(CHECKOUT_SESSION, session)).toEqual([])
    expect(cart.totals.discountTotalMinor).toBeGreaterThan(0)
    expect({
      base: totalOf(session, 'items_base_amount'),
      discount: discountOf(session),
      subtotal: totalOf(session, 'subtotal'),
      total: totalOf(session, 'total'),
    }).toEqual({
      base: cart.subtotalMinor,
      discount: cart.totals.discountTotalMinor,
      subtotal: cart.subtotalMinor - cart.totals.discountTotalMinor,
      total: cart.totals.totalMinor,
    })
  })

  // Kills: a finished session that loses what was applied once its cart is emptied.
  it('AC-11: a completed session shows discounts.codes and applied from its order, and the order’s discount and total as its totals', async () => {
    const created = answered(
      await agent.create(
        withCodes(createBody([line(1, 2)], { email: buyerEmail('codes-done') }), {
          discounts: [ten],
        }),
      ),
      201,
      'create',
    )
    const done = answered(await agent.complete(created.id, sptPayment('spt_done')), 200, 'complete')
    const order = await store.kernel.services.order.getById(done.order!.id)
    const read = answered(await agent.get(created.id), 200, 'read')

    expect(read.status).toBe('completed')
    expect(validateAcp(WITH_ORDER, read)).toEqual([])
    expect(order.discountTotalMinor).toBeGreaterThan(0)
    expect(read.discounts?.codes).toEqual([ten])
    expect((read.discounts?.applied ?? []).map((a) => a.amount)).toEqual([order.discountTotalMinor])
    expect(read.discounts?.rejected).toEqual([])
    expect({ discount: discountOf(read), total: totalOf(read, 'total') }).toEqual({
      discount: order.discountTotalMinor,
      total: order.totalMinor,
    })
  })
})
