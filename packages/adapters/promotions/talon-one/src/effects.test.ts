import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PromotionEffect, PromotionsAdapter } from '@nymbalhq/types'
import { startFakeTalonOne, type FakeTalonOne } from './tests/fake-talon-one.js'
import { effect, line, scripted, session, talonOne } from './tests/support.js'

// Talon.One's effects as the adapter reads them into the kernel's: discounts on the cart and on a line, code verdicts
// in the cart's own spelling, notices, and everything else answered as unsupported, in the order Talon.One sent them.
// The fake is told exactly what to answer; the session is the cart the kernel sent.

let fake: FakeTalonOne
let adapter: PromotionsAdapter

beforeAll(async () => {
  fake = await startFakeTalonOne()
  adapter = await talonOne(fake)
})
afterAll(async () => {
  await fake.close()
})
beforeEach(() => {
  fake.answer(null)
})

const cart = session({
  id: 'cart-fx',
  codes: ['SAVE10', 'BAD1'],
  lines: [
    line(1, { id: 'line-a', variantId: 'var-a', unitMinor: 1250, qty: 1 }),
    line(2, { id: 'line-b', variantId: 'var-b', unitMinor: 800, qty: 3 }),
  ],
})

async function read(
  effects: Record<string, unknown>[],
  coupons: { id: number; value: string }[] = [],
  s = cart,
): Promise<PromotionEffect[]> {
  scripted(fake, effects, coupons)
  return (await adapter.evaluate(s, { dry: true })).effects
}

describe('AC-3: each Talon.One effect becomes the kernel’s, in order', () => {
  it('AC-3: setDiscount is an order discount of props.value in minor units, labelled props.name', async () => {
    expect(await read([effect('setDiscount', { name: 'Spring sale', value: 2.5 })])).toEqual([
      { kind: 'order', amountMinor: 250, label: 'Spring sale' },
    ])
  })

  it('AC-3: setDiscountPerItem with no scope, or scope price, is a line discount on the session line at props.position', async () => {
    const plain = await read([
      effect('setDiscountPerItem', { name: 'Line deal', value: 1.1, position: 1, subPosition: 0 }),
    ])
    const priced = await read([
      effect('setDiscountPerItem', {
        name: 'Line deal',
        value: 1.1,
        position: 0,
        subPosition: 0,
        scope: 'price',
      }),
    ])

    expect(plain).toEqual([
      { kind: 'line', lineId: 'line-b', amountMinor: 110, label: 'Line deal' },
    ])
    expect(priced).toEqual([
      { kind: 'line', lineId: 'line-a', amountMinor: 110, label: 'Line deal' },
    ])
  })

  it('AC-3: acceptCoupon for save10 on a session holding SAVE10 is code_accepted for SAVE10; for a code the session does not hold it is props.value', async () => {
    const matched = await read([effect('acceptCoupon', { value: 'save10' })])
    const other = await read([effect('acceptCoupon', { value: 'Elsewhere7' })])

    expect(matched).toEqual([{ kind: 'code_accepted', code: 'SAVE10' }])
    expect(other).toEqual([{ kind: 'code_accepted', code: 'Elsewhere7' }])
  })

  it('AC-3: rejectCoupon is code_rejected for the code', async () => {
    const effects = await read([
      effect('rejectCoupon', { value: 'BAD1', rejectionReason: 'CouponNotFound' }),
    ])
    expect(effects).toEqual([{ kind: 'code_rejected', code: 'BAD1', reason: 'unknown' }])
  })

  it('AC-3: showNotification is a notice with props.body', async () => {
    const effects = await read([
      effect('showNotification', {
        notificationType: 'info',
        title: 'Nearly there',
        body: 'Spend £50 for free delivery',
      }),
    ])
    expect(effects).toEqual([{ kind: 'notice', text: 'Spend £50 for free delivery' }])
  })

  it('AC-3: a shipping discount, a free item, loyalty, a referral, a per-item discount of another scope and one at a position the cart has no line at are unsupported, naming the effect type, and move no money', async () => {
    const sent = [
      effect('setDiscountPerAdditionalCost', {
        name: 'Ship free',
        value: 4.99,
        additionalCost: 'shipping',
      }),
      effect('addFreeItem', { sku: 'GIFT-1', name: 'Gift' }),
      effect('addLoyaltyPoints', { name: 'Points', value: 25, programId: 3 }),
      effect('redeemReferral', { programId: 4, value: 'REF-1' }),
      effect('setDiscountPerItem', {
        name: 'Additional cost off',
        value: 2,
        position: 0,
        subPosition: 0,
        scope: 'additionalCosts',
      }),
      effect('setDiscountPerItem', { name: 'Nowhere', value: 3, position: 9, subPosition: 0 }),
    ]

    const effects = await read(sent)

    expect(effects).toEqual(sent.map((e) => ({ kind: 'unsupported', detail: e['effectType'] })))
  })

  it('AC-3: an answer mixing every row keeps Talon.One’s order', async () => {
    const effects = await read(
      [
        effect('acceptCoupon', { value: 'SAVE10' }, { triggeredByCoupon: 501 }),
        effect('setDiscount', { name: 'Ten off', value: 3 }, { triggeredByCoupon: 501 }),
        effect('showNotification', { notificationType: 'info', title: 't', body: 'Hello' }),
        effect('rejectCoupon', { value: 'bad1', rejectionReason: 'CouponExpired' }),
        effect('setDiscountPerItem', { name: 'Per item', value: 0.5, position: 0, subPosition: 0 }),
        effect('addFreeItem', { sku: 'GIFT-1', name: 'Gift' }),
      ],
      [{ id: 501, value: 'SAVE10' }],
    )

    expect(effects).toEqual([
      { kind: 'code_accepted', code: 'SAVE10' },
      { kind: 'order', amountMinor: 300, label: 'Ten off', code: 'SAVE10' },
      { kind: 'notice', text: 'Hello' },
      { kind: 'code_rejected', code: 'BAD1', reason: 'expired' },
      { kind: 'line', lineId: 'line-a', amountMinor: 50, label: 'Per item' },
      { kind: 'unsupported', detail: 'addFreeItem' },
    ])
  })

  it('AC-3: a money effect triggered by a coupon in the answer carries that code; one triggered by a coupon the answer does not list, or by none, carries no code', async () => {
    const effects = await read(
      [
        effect('acceptCoupon', { value: 'SAVE10' }, { triggeredByCoupon: 501 }),
        effect('setDiscount', { name: 'By coupon', value: 1 }, { triggeredByCoupon: 501 }),
        effect('setDiscount', { name: 'Unlisted coupon', value: 2 }, { triggeredByCoupon: 999 }),
        effect('setDiscount', { name: 'Campaign', value: 3 }),
        effect(
          'setDiscountPerItem',
          { name: 'By coupon per item', value: 0.25, position: 1, subPosition: 0 },
          { triggeredByCoupon: 501 },
        ),
      ],
      [{ id: 501, value: 'SAVE10' }],
    )

    const money = effects.filter((e) => e.kind === 'order' || e.kind === 'line')
    expect(money.map((e) => [e.label, Object.hasOwn(e, 'code') ? e.code : null])).toEqual([
      ['By coupon', 'SAVE10'],
      ['Unlisted coupon', null],
      ['Campaign', null],
      ['By coupon per item', 'SAVE10'],
    ])
  })
})

describe('AC-4: a line’s per-unit discounts become one line discount', () => {
  it('AC-4: three units of one position sum to one line effect of the rounded sum', async () => {
    const values = [1.111, 1.111, 1.111]
    const effects = await read(
      values.map((value, subPosition) =>
        effect('setDiscountPerItem', { name: 'Three for less', value, position: 1, subPosition }),
      ),
    )

    const lines = effects.filter((e) => e.kind === 'line')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ lineId: 'line-b', label: 'Three for less' })
    expect((lines[0] as { amountMinor: number }).amountMinor).toBe(
      Math.round(values.reduce((sum, v) => sum + v, 0) * 100),
    )
  })

  it('AC-4: units of two positions give one effect per line, each its own sum; a position past the cart’s lines gives unsupported and no line', async () => {
    const effects = await read([
      effect('setDiscountPerItem', { name: 'Deal', value: 0.5, position: 0, subPosition: 0 }),
      effect('setDiscountPerItem', { name: 'Deal', value: 0.25, position: 1, subPosition: 0 }),
      effect('setDiscountPerItem', { name: 'Deal', value: 0.25, position: 1, subPosition: 1 }),
      effect('setDiscountPerItem', { name: 'Deal', value: 0.25, position: 1, subPosition: 2 }),
      effect('setDiscountPerItem', { name: 'Deal', value: 4, position: 2, subPosition: 0 }),
    ])

    const lines = effects.filter((e) => e.kind === 'line')
    expect(lines.map((e) => [e.lineId, e.amountMinor])).toEqual([
      ['line-a', 50],
      ['line-b', 75],
    ])
    expect(effects.filter((e) => e.kind === 'unsupported')).toEqual([
      { kind: 'unsupported', detail: 'setDiscountPerItem' },
    ])
  })

  it('AC-4: for any quantity 1..9 and per-unit values in thousandths, one line effect whose amount is the sum rounded to minor units', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 1, max: 9 })
          .chain((qty) =>
            fc.tuple(
              fc.constant(qty),
              fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: qty, maxLength: qty }),
            ),
          ),
        async ([qty, thousandths]) => {
          const sum = thousandths.reduce((a, b) => a + b, 0)
          // Exactly half a minor unit is where two honest summation orders may round apart.
          fc.pre(sum % 10 !== 5)
          const s = session({
            id: 'cart-units',
            lines: [line(1, { id: 'only-line', unitMinor: 100_000, qty })],
          })
          const effects = await read(
            thousandths.map((t, subPosition) =>
              effect('setDiscountPerItem', {
                name: 'Units',
                value: t / 1000,
                position: 0,
                subPosition,
              }),
            ),
            [],
            s,
          )
          const lines = effects.filter((e) => e.kind === 'line')
          expect(lines.map((e) => e.lineId)).toEqual(['only-line'])
          expect((lines[0] as { amountMinor: number }).amountMinor).toBe(Math.round(sum / 10))
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('AC-5: a refused code’s reason is one the storefront can read', () => {
  const REASONS: [string, string][] = [
    ['CouponExpired', 'expired'],
    ['CouponLimitReached', 'cap_reached'],
    ['CampaignLimitReached', 'cap_reached'],
    ['ProfileLimitReached', 'cap_reached'],
    ['CouponNotFound', 'unknown'],
    ['CouponRejectedByCondition', 'unknown'],
    ['CouponReasonFromALaterVersion', 'unknown'],
  ]

  it('AC-5: each rejectionReason maps to its reason, an unknown one to unknown without throwing, and the code is the session’s spelling', async () => {
    for (const [rejectionReason, reason] of REASONS) {
      const effects = await read([effect('rejectCoupon', { value: 'save10', rejectionReason })])
      expect(effects, rejectionReason).toEqual([{ kind: 'code_rejected', code: 'SAVE10', reason }])
    }
  })
})

describe('AC-17: a coupon that moves no money and brings only what the kernel cannot act on is refused', () => {
  const gift = session({ id: 'cart-gift', codes: ['FREEGIFT'] })
  const coupons = [{ id: 610, value: 'FREEGIFT' }]
  const verdicts = (effects: PromotionEffect[]) =>
    effects.filter((e) => e.kind === 'code_accepted' || e.kind === 'code_rejected')

  it('AC-17: acceptCoupon with no money effect triggered by it and an addFreeItem is code_rejected (unknown) and never code_accepted', async () => {
    const effects = await read(
      [
        effect('acceptCoupon', { value: 'FREEGIFT' }, { triggeredByCoupon: 610 }),
        effect('addFreeItem', { sku: 'GIFT-1', name: 'Gift' }, { triggeredByCoupon: 610 }),
      ],
      coupons,
      gift,
    )

    expect(verdicts(effects)).toEqual([
      { kind: 'code_rejected', code: 'FREEGIFT', reason: 'unknown' },
    ])
  })

  it('AC-17: the same answer with a setDiscount triggered by the coupon is code_accepted', async () => {
    const effects = await read(
      [
        effect('acceptCoupon', { value: 'FREEGIFT' }, { triggeredByCoupon: 610 }),
        effect('addFreeItem', { sku: 'GIFT-1', name: 'Gift' }, { triggeredByCoupon: 610 }),
        effect('setDiscount', { name: 'Gift and money', value: 1 }, { triggeredByCoupon: 610 }),
      ],
      coupons,
      gift,
    )

    expect(verdicts(effects)).toEqual([{ kind: 'code_accepted', code: 'FREEGIFT' }])
  })

  it('AC-17: an acceptCoupon alone, with nothing unsupported in the answer, is code_accepted', async () => {
    const effects = await read(
      [effect('acceptCoupon', { value: 'FREEGIFT' }, { triggeredByCoupon: 610 })],
      coupons,
      gift,
    )

    expect(verdicts(effects)).toEqual([{ kind: 'code_accepted', code: 'FREEGIFT' }])
  })
})
