import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parsePercentBps, toPercentInput } from './percent'

// A percent the merchant types is stored as basis points, read from its digits: "12.5" is 1250, never 12.5 × 100 in
// floating point (1.15 × 100 is 114.99999999999999). Anything that is not a plain decimal with at most two fraction
// digits, or whose basis points fall outside 1 to 9999, is no percent at all.

const digits = (min: number, max: number) =>
  fc
    .array(fc.constantFrom(...'0123456789'.split('')), { minLength: min, maxLength: max })
    .map((ds) => ds.join(''))

/** A whole part with no leading zero but "0" itself. */
const whole = fc.nat({ max: 250 }).map(String)

/** The basis points a decimal's digits spell: whole × 100 plus the fraction padded to two digits. */
const spelled = (w: string, fraction: string): number =>
  Number(w) * 100 + Number(fraction.padEnd(2, '0'))

describe('AC-1: a percent is read from its digits', () => {
  // Kills: a toPercentInput that rounds or pads ("12.50", "0.0"), so the edit form's value parses to another number.
  it('AC-1: property: every basis point from 1 to 9999 survives toPercentInput then parsePercentBps; 1000, 1250 and 1 read "10", "12.5" and "0.01"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9999 }), (bps) => {
        expect(parsePercentBps(toPercentInput(bps)), `${bps} as "${toPercentInput(bps)}"`).toBe(bps)
      }),
      { numRuns: 2000 },
    )
    expect([1000, 1250, 1].map(toPercentInput)).toEqual(['10', '12.5', '0.01'])
  })

  // Kills: `Math.round(Number(text) * 100)` or `Math.trunc(parseFloat(text) * 100)`: 1.15 reads 114 truncated, and a
  // float path drifts somewhere in the space this walks.
  it('AC-1: property: a decimal with at most two fraction digits reads the integer its digits spell when that is 1 to 9999, else null; "1.15" is 115, "12.5" is 1250, "0.07" is 7', () => {
    fc.assert(
      fc.property(whole, digits(0, 2), (w, fraction) => {
        const text = fraction === '' ? w : `${w}.${fraction}`
        const bps = spelled(w, fraction)
        expect(parsePercentBps(text), `"${text}"`).toBe(bps >= 1 && bps <= 9999 ? bps : null)
      }),
      { numRuns: 3000 },
    )
    const read = ['1.15', '12.5', '0.07', '0.01', '99.99', '100', '0', '0.00', '4.10'].map(
      parsePercentBps,
    )
    expect(read).toEqual([115, 1250, 7, 1, 9999, null, null, null, 410])
  })

  // Kills: `Number(text)` as the reader: "1e1" is 10%, "0x10" is 16%, "" and "  " are 0, "-5" and "+5" are numbers.
  it('AC-1: property: three fraction digits, a sign, an exponent, a comma, blanks only or letters read null', () => {
    const decimal = fc.tuple(whole, digits(0, 2)).map(([w, f]) => (f === '' ? w : `${w}.${f}`))
    const malformed = fc.oneof(
      fc.tuple(whole, digits(3, 5)).map(([w, f]) => `${w}.${f}`),
      fc.tuple(fc.constantFrom('-', '+'), decimal).map(([sign, d]) => `${sign}${d}`),
      fc
        .tuple(fc.integer({ min: 1, max: 99 }), fc.constantFrom('e', 'E'), fc.nat({ max: 3 }))
        .map(([m, e, x]) => `${m}${e}${x}`),
      fc.tuple(whole, digits(1, 3)).map(([w, f]) => `${w},${f}`),
      fc.array(fc.constantFrom(' ', '\t', '\n'), { maxLength: 4 }).map((bs) => bs.join('')),
      fc
        .tuple(decimal, fc.constantFrom(...'abcxyzXOQ'.split('')), fc.nat({ max: 3 }))
        .map(([d, letter, at]) => `${d.slice(0, at)}${letter}${d.slice(at)}`),
    )
    fc.assert(
      fc.property(malformed, (text) => {
        expect(parsePercentBps(text), JSON.stringify(text)).toBeNull()
      }),
      { numRuns: 2000 },
    )
    const read = ['1e1', '0x10', '', '   ', '-5', '+5', '1,5', '1.155', 'abc', 'Infinity', 'NaN']
    expect(read.map(parsePercentBps)).toEqual(read.map(() => null))
  })
})
