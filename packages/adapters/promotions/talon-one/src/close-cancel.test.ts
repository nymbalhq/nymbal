import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PromotionOrder, PromotionsAdapter } from '@nymbalhq/types'
import { startFakeTalonOne, type FakeTalonOne } from './tests/fake-talon-one.js'
import { outcomeOf, recordingLogger, session, stringsIn, talonOne } from './tests/support.js'

// Telling Talon.One an order was paid (close) or called off (cancel): one PUT on the order's own session with the new
// state and an idempotency key per order and state, so a retried event replays the first answer and the state is set
// once. A use Talon.One refuses at close is logged as an error and the close stands; a failure rejects for a retry.

let fake: FakeTalonOne

beforeAll(async () => {
  fake = await startFakeTalonOne()
})
afterAll(async () => {
  await fake.close()
})
beforeEach(() => {
  fake.answer(null)
  fake.coupons([])
})

let orders = 0

/** An order placed through the adapter: its session saved open at the fake under the order's id. */
async function placed(
  adapter: PromotionsAdapter,
  codes: string[] = [],
): Promise<{ cartToken: string; order: PromotionOrder }> {
  orders += 1
  const cartToken = `cart-close-${orders}`
  const orderId = `order-close-${orders}`
  await adapter.evaluate(session({ id: cartToken, codes }), { orderId })
  expect(fake.sessions.get(orderId)?.state).toBe('open')
  return {
    cartToken,
    order: {
      orderId,
      orderNumber: `NYM-${1000 + orders}`,
      currency: 'GBP',
      subtotalMinor: 1250,
      discountTotalMinor: 0,
      totalMinor: 1250,
    },
  }
}

describe('AC-8: close and cancel set the order’s session state once', () => {
  it('AC-8: close sends PUT /v2/customer_sessions/<orderId> with state closed and Idempotency-Key <orderId>:closed; twice, the state is set once', async () => {
    const adapter = await talonOne(fake)
    const { cartToken, order } = await placed(adapter)
    const from = fake.requests.length

    await adapter.close!(cartToken, order)
    await adapter.close!(cartToken, order)

    const sent = fake.requests.slice(from)
    expect(sent.map((r) => [r.method, r.path, r.idempotencyKey])).toEqual([
      ['PUT', `/v2/customer_sessions/${order.orderId}`, `${order.orderId}:closed`],
      ['PUT', `/v2/customer_sessions/${order.orderId}`, `${order.orderId}:closed`],
    ])
    expect(
      sent.map((r) => (r.body as { customerSession: { state: string } }).customerSession.state),
    ).toEqual(['closed', 'closed'])
    const saved = fake.sessions.get(order.orderId)!
    expect(saved.state).toBe('closed')
    expect(saved.stateSets.closed).toBe(1)
    expect(fake.sessions.has(cartToken)).toBe(false)
  })

  it('AC-8: cancel sends the same with state cancelled and Idempotency-Key <orderId>:cancelled; twice, the state is set once', async () => {
    const adapter = await talonOne(fake)
    const { cartToken, order } = await placed(adapter)
    const from = fake.requests.length

    await adapter.cancel!(cartToken, order.orderId)
    await adapter.cancel!(cartToken, order.orderId)

    const sent = fake.requests.slice(from)
    expect(sent.map((r) => [r.method, r.path, r.idempotencyKey])).toEqual([
      ['PUT', `/v2/customer_sessions/${order.orderId}`, `${order.orderId}:cancelled`],
      ['PUT', `/v2/customer_sessions/${order.orderId}`, `${order.orderId}:cancelled`],
    ])
    expect(
      sent.map((r) => (r.body as { customerSession: { state: string } }).customerSession.state),
    ).toEqual(['cancelled', 'cancelled'])
    const saved = fake.sessions.get(order.orderId)!
    expect(saved.state).toBe('cancelled')
    expect(saved.stateSets.cancelled).toBe(1)
  })

  it('AC-8: a paid order’s close counts its code once, however often it is sent', async () => {
    fake.coupons([{ code: 'ONCE', percent: 10 }])
    const adapter = await talonOne(fake)
    const { cartToken, order } = await placed(adapter, ['ONCE'])
    const before = fake.uses('ONCE')

    await adapter.close!(cartToken, order)
    await adapter.close!(cartToken, order)
    await adapter.close!(cartToken, order)

    expect(fake.uses('ONCE')).toBe(before + 1)
  })

  it('AC-8: a close whose answer refuses the code resolves, and logs at error with the order id and the code', async () => {
    fake.coupons([{ code: 'CAPPED1', amount: 2, limit: 1 }])
    const { logger, lines } = recordingLogger()
    const adapter = await talonOne(fake, {}, logger)
    const first = await placed(adapter, ['CAPPED1'])
    const second = await placed(adapter, ['CAPPED1'])
    await adapter.close!(first.cartToken, first.order)
    const errorsBefore = lines.filter((l) => l.level === 'error').length

    const { error } = await outcomeOf(() => adapter.close!(second.cartToken, second.order))

    expect(error).toBeUndefined()
    const answered = fake.requests.at(-1)!.response as { effects: { effectType: string }[] }
    expect(answered.effects.map((e) => e.effectType)).toContain('rejectCoupon')
    expect(fake.sessions.get(second.order.orderId)!.state).toBe('closed')
    const errors = lines.filter((l) => l.level === 'error').slice(errorsBefore)
    const naming = errors.filter((l) => {
      const said = stringsIn([l]).join('\n')
      return said.includes(second.order.orderId) && said.includes('CAPPED1')
    })
    expect(naming.length).toBeGreaterThanOrEqual(1)
  })

  it('AC-8: a close or cancel answered 500 rejects, and the session keeps its state', async () => {
    const adapter = await talonOne(fake)
    const { cartToken, order } = await placed(adapter)
    fake.answer({ status: 500, body: { message: 'Internal error' } })

    const closed = await outcomeOf(() => adapter.close!(cartToken, order))
    const cancelled = await outcomeOf(() => adapter.cancel!(cartToken, order.orderId))

    expect(closed.error).toBeInstanceOf(Error)
    expect(cancelled.error).toBeInstanceOf(Error)
    expect((closed.error as Error).message).toContain('500')
    expect((cancelled.error as Error).message).toContain('500')
    expect(fake.sessions.get(order.orderId)!.state).toBe('open')
  })
})
