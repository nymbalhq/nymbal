import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as types from './index.js'

// P2-12 AC-4 (the rule): `@nymbalhq/types` holds the one stock rule both PDPs render from: `stockLevel(stock)` is
// 'out' at <= 0, 'low' on 1-4 and 'in' at >= 5, and `STOCK_LABELS` names each level. Kills: a boundary moved (out at
// `=== 0`, low at `<= 5`), a negative stock read as low or in, and labels that differ from the spec's.

type Level = 'out' | 'low' | 'in'

/** The spec's rule (decision 5), written out independently of the implementation. */
const specLevel = (stock: number): Level => (stock <= 0 ? 'out' : stock < 5 ? 'low' : 'in')

const { stockLevel, STOCK_LABELS } = types as unknown as {
  stockLevel?: (stock: number) => Level
  STOCK_LABELS?: Record<Level, string>
}

describe('P2-12: one stock rule', () => {
  it('AC-4: stockLevel over all integers is out at <= 0, low on 1-4 and in at >= 5', () => {
    expect(typeof stockLevel, '@nymbalhq/types exports stockLevel').toBe('function')
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.integer({ min: -10, max: 10 })), (stock) => {
        expect(stockLevel!(stock)).toBe(specLevel(stock))
      }),
      { numRuns: 1000 },
    )
  })

  it('AC-4: STOCK_LABELS names every level with the spec’s label', () => {
    expect(STOCK_LABELS, '@nymbalhq/types exports STOCK_LABELS').toEqual({
      out: 'Out of Stock',
      low: 'Low Stock',
      in: 'In Stock',
    })
  })
})
