import { describe, expect, it } from 'vitest'
import { money, add, sub, mulBy, sumMoney, allocate } from './money.js'

describe('money', () => {
  it('money() enforces integer minor units', () => {
    expect(() => money(1.5, 'GBP')).toThrow()
    expect(money(100, 'GBP')).toEqual({ amount: 100, currency: 'GBP' })
  })

  it('add rejects currency mismatch', () => {
    expect(() => add(money(100, 'GBP'), money(100, 'USD'))).toThrow()
    expect(add(money(100, 'GBP'), money(50, 'GBP'))).toEqual({
      amount: 150,
      currency: 'GBP',
    })
  })

  it('sub', () => {
    expect(sub(money(500, 'GBP'), money(200, 'GBP'))).toEqual({ amount: 300, currency: 'GBP' })
  })

  it('mulBy rounds half-up', () => {
    expect(mulBy(money(1000, 'GBP'), 0.2)).toEqual({ amount: 200, currency: 'GBP' })
    expect(mulBy(money(333, 'GBP'), 2)).toEqual({ amount: 666, currency: 'GBP' })
  })

  it('sumMoney totals', () => {
    expect(sumMoney([money(100, 'GBP'), money(200, 'GBP')], 'GBP')).toEqual({
      amount: 300,
      currency: 'GBP',
    })
  })

  it('allocate splits amount by weights without loss', () => {
    const parts = allocate(money(100, 'GBP'), [1, 1, 1])
    const total = parts.reduce((s, p) => s + p.amount, 0)
    expect(total).toBe(100)
    // One of them must carry the rounding remainder
    expect(parts.map((p) => p.amount).sort()).toEqual([33, 33, 34])
  })
})
