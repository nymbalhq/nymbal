import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  FAKE_TALON_ONE_API_KEY,
  startFakeTalonOne,
  type FakeTalonOne,
  type RecordedRequest,
} from './tests/fake-talon-one.js'
import { effect, line, scripted, session, talonOne } from './tests/support.js'

// What the adapter sends Talon.One for a session and what it reads back as money: one PUT per evaluation, keyed by
// the cart for a preview (nothing saved) and by the order for the place call (saved, open); prices sent in major
// units by the currency's exponent, and amounts read back rounded to whole minor units.

let fake: FakeTalonOne

beforeAll(async () => {
  fake = await startFakeTalonOne()
})
afterAll(async () => {
  await fake.close()
})
beforeEach(() => {
  fake.answer(null)
})

const sent = (from: number): RecordedRequest[] => fake.requests.slice(from)

describe('AC-1: one PUT per evaluation, a preview keyed by the cart and saving nothing, the place call keyed by the order', () => {
  it('AC-1: a dry evaluate sends one PUT /v2/customer_sessions/<cart token>?dry=true with the API key and the session as Talon.One reads it, and saves nothing', async () => {
    const adapter = await talonOne(fake)
    const s = session({
      id: 'cart-tok-ac1',
      customerId: 'customer-42',
      codes: ['SPRING', 'EXTRA5'],
      lines: [
        line(1, { unitMinor: 1999, qty: 2 }),
        line(2, { sku: '', variantId: 'variant-without-sku', unitMinor: 500, qty: 1 }),
        line(3, { unitMinor: 1, qty: 7 }),
      ],
    })
    const from = fake.requests.length
    const savedBefore = fake.sessions.size

    await adapter.evaluate(s, { dry: true })

    const requests = sent(from)
    expect(requests.map((r) => [r.method, r.path, r.query['dry']])).toEqual([
      ['PUT', '/v2/customer_sessions/cart-tok-ac1', 'true'],
    ])
    const [request] = requests
    expect(request!.authorization).toBe(`ApiKey-v1 ${FAKE_TALON_ONE_API_KEY}`)
    expect(request!.status).toBe(200)
    const body = request!.body as {
      customerSession: Record<string, unknown>
      responseContent: unknown
    }
    expect(body.responseContent).toEqual(['coupons'])
    expect(body.customerSession).toMatchObject({
      profileId: 'customer-42',
      state: 'open',
      couponCodes: s.codes,
    })
    const items = body.customerSession['cartItems'] as Record<string, unknown>[]
    expect(
      items.map((i) => ({ sku: i['sku'], quantity: i['quantity'], price: i['price'] })),
    ).toEqual(
      s.lines.map((l) => ({
        sku: l.sku === '' ? l.variantId : l.sku,
        quantity: l.qty,
        price: l.unitMinor / 100,
      })),
    )
    expect(fake.sessions.size).toBe(savedBefore)
  })

  it('AC-1: a guest session sends no profileId', async () => {
    const adapter = await talonOne(fake)
    const from = fake.requests.length

    await adapter.evaluate(session({ id: 'cart-tok-guest', customerId: null }), { dry: true })

    const [request] = sent(from)
    const customerSession = (request!.body as { customerSession: Record<string, unknown> })
      .customerSession
    expect(request!.status).toBe(200)
    expect(Object.hasOwn(customerSession, 'profileId')).toBe(false)
  })

  it('AC-1: with an orderId the PUT goes to /v2/customer_sessions/<orderId> with no dry, and the fake then holds exactly that session, open, with the session’s items and codes', async () => {
    const adapter = await talonOne(fake)
    const orderId = 'order-ac1-0001'
    const s = session({
      id: 'cart-tok-ac1-place',
      codes: ['SPRING'],
      lines: [line(1, { unitMinor: 1200, qty: 3 })],
    })
    const from = fake.requests.length
    const savedBefore = [...fake.sessions.keys()]

    await adapter.evaluate(s, { orderId })

    const requests = sent(from)
    expect(requests.map((r) => [r.method, r.path, r.query['dry'] ?? 'false'])).toEqual([
      ['PUT', `/v2/customer_sessions/${orderId}`, 'false'],
    ])
    expect([...fake.sessions.keys()]).toEqual([...savedBefore, orderId])
    expect(fake.sessions.has(s.id)).toBe(false)
    const saved = fake.sessions.get(orderId)!
    expect(saved.state).toBe('open')
    expect(saved.couponCodes).toEqual(s.codes)
    expect(saved.cartItems).toEqual([{ sku: 'SKU-1', quantity: 3, price: 12 }])
  })

  it('AC-1: the place call answers the order id as its evaluationId, so the order keeps a record to close even with no discount; a dry call answers none', async () => {
    const adapter = await talonOne(fake)
    const orderId = 'order-ac1-no-discount'
    const s = session({ id: 'cart-tok-ac1-plain', codes: [] })

    const placed = await adapter.evaluate(s, { orderId })
    const previewed = await adapter.evaluate(s, { dry: true })

    expect(placed.effects).toEqual([])
    expect(placed.evaluationId).toBe(orderId)
    expect(fake.sessions.has(placed.evaluationId!)).toBe(true)
    expect(previewed.effects).toEqual(placed.effects)
    expect(Object.hasOwn(previewed, 'evaluationId')).toBe(false)
  })
})

const EXPONENT = { JPY: 0, GBP: 2, KWD: 3 } as const
type Currency = keyof typeof EXPONENT
const currencies = fc.constantFrom<Currency>('JPY', 'GBP', 'KWD')

describe('AC-2: money crosses in major units by the currency’s exponent and comes back as whole minor units', () => {
  it('AC-2: for any unit price 0..10^9 minor in JPY, GBP or KWD, the price sent times 10^e rounds back to the unit price', async () => {
    const adapters = new Map<Currency, Awaited<ReturnType<typeof talonOne>>>()
    for (const c of Object.keys(EXPONENT) as Currency[]) {
      adapters.set(c, await talonOne(fake, { currency: c }))
    }
    await fc.assert(
      fc.asyncProperty(
        currencies,
        fc.integer({ min: 0, max: 1_000_000_000 }),
        async (currency, unitMinor) => {
          const from = fake.requests.length
          await adapters
            .get(currency)!
            .evaluate(session({ currency, lines: [line(1, { unitMinor })] }), { dry: true })
          const [request] = sent(from)
          const cs = (request!.body as { customerSession: { cartItems: { price: number }[] } })
            .customerSession
          const price = cs.cartItems[0]!.price
          expect(typeof price).toBe('number')
          expect(Math.round(price * 10 ** EXPONENT[currency])).toBe(unitMinor)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-2: for any effect value 0..10^9 in JPY, GBP or KWD, the amountMinor answered is a safe integer equal to Math.round(value × 10^e)', async () => {
    const adapters = new Map<Currency, Awaited<ReturnType<typeof talonOne>>>()
    for (const c of Object.keys(EXPONENT) as Currency[]) {
      adapters.set(c, await talonOne(fake, { currency: c }))
    }
    await fc.assert(
      fc.asyncProperty(
        currencies,
        fc
          .double({ min: 0, max: 1_000_000_000, noNaN: true })
          // -0 reads as 0: Object.is would tell them apart.
          .map((v) => v + 0),
        async (currency, value) => {
          scripted(fake, [effect('setDiscount', { name: 'Generated', value })])
          const { effects } = await adapters
            .get(currency)!
            .evaluate(session({ currency }), { dry: true })
          const money = effects.filter((e) => e.kind === 'order')
          expect(money).toHaveLength(1)
          const amount = (money[0] as { amountMinor: number }).amountMinor
          expect(Number.isSafeInteger(amount)).toBe(true)
          expect(amount).toBe(Math.round(value * 10 ** EXPONENT[currency]))
        },
      ),
      { numRuns: 60 },
    )
  })
})
