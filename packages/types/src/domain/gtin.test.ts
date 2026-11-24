import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isGtin } from '../index.js'

// A GTIN is 8, 12, 13 or 14 digits whose last digit is the GS1 check digit. Nothing here computes a check digit: for
// any body exactly one of the ten final digits makes a GTIN, the published codes below fix which, and the GS1 check
// is blind to leading zeros (its weights run from the right), so a GTIN padded with zeros to a longer length stays one.

const GTINS = ['96385074', '036000291452', '4006381333931', '9780306406157', '00012345600012']
const NOT_GTINS = ['4006381333932', '0306406152']
const LENGTHS = [8, 12, 13, 14]

const digits = (length: number) =>
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: length, maxLength: length })
    .map((d) => d.join(''))

/** A body of 7, 11, 12 or 13 digits, one short of a GTIN length. */
const body = fc.constantFrom(...LENGTHS.map((n) => n - 1)).chain(digits)

/** The one final digit that makes `head` a GTIN, found by asking `isGtin` itself. */
function completed(head: string): string[] {
  return Array.from({ length: 10 }, (_, d) => `${head}${d}`).filter((code) => isGtin(code))
}

/** A GTIN of a generated body: the body with the one final digit `isGtin` takes. */
const gtin = body.map((head) => completed(head)[0] ?? `${head}x`)

describe('isGtin', () => {
  it('AC-1: the published GTIN-8, GTIN-12, GTIN-13, ISBN-13 and GTIN-14 codes are GTINs; a GTIN-13 with a wrong check digit and an ISBN-10 are not', () => {
    expect(GTINS.map((code) => [code, isGtin(code)])).toEqual(GTINS.map((code) => [code, true]))
    expect(NOT_GTINS.map((code) => [code, isGtin(code)])).toEqual(
      NOT_GTINS.map((code) => [code, false]),
    )
  })

  it('AC-1: property: for any body of 7, 11, 12 or 13 digits exactly one of the ten final digits makes a GTIN', () => {
    fc.assert(
      fc.property(body, (head) => {
        expect(completed(head).length, head).toBe(1)
      }),
      { numRuns: 500 },
    )
  })

  it('AC-1: property: a GTIN with its last digit changed is not a GTIN', () => {
    fc.assert(
      fc.property(gtin, fc.integer({ min: 1, max: 9 }), (code, shift) => {
        const last = (Number(code.at(-1)) + shift) % 10
        const changed = `${code.slice(0, -1)}${last}`
        expect([isGtin(code), isGtin(changed)], `${code} -> ${changed}`).toEqual([true, false])
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: property: any one digit of a GTIN changed makes it no GTIN', () => {
    fc.assert(
      fc.property(gtin, fc.nat(), fc.integer({ min: 1, max: 9 }), (code, at, shift) => {
        const i = at % code.length
        const moved = (Number(code[i]) + shift) % 10
        const changed = `${code.slice(0, i)}${moved}${code.slice(i + 1)}`
        expect(isGtin(changed), `${code} -> ${changed}`).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: property: a GTIN padded with leading zeros to any longer GTIN length is a GTIN, and a code is a GTIN exactly when its zero-padded GTIN-14 is', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LENGTHS).chain(digits), (code) => {
        const padded = LENGTHS.filter((n) => n > code.length).map((n) => code.padStart(n, '0'))
        expect(
          padded.map((p) => [p, isGtin(p)]),
          code,
        ).toEqual(padded.map((p) => [p, isGtin(code)]))
      }),
      { numRuns: 500 },
    )
    for (const code of GTINS) expect([code, isGtin(code.padStart(14, '0'))]).toEqual([code, true])
  })

  it('AC-1: property: a digit string of any length other than 8, 12, 13 or 14 is not a GTIN', () => {
    const otherLength = fc
      .integer({ min: 0, max: 20 })
      .filter((n) => !LENGTHS.includes(n))
      .chain(digits)
    fc.assert(
      fc.property(otherLength, (code) => {
        expect(isGtin(code), `${code} (${code.length} digits)`).toBe(false)
      }),
      { numRuns: 500 },
    )
    for (const code of GTINS) {
      for (const longer of [`${code}0`, `0${code}`].filter((c) => !LENGTHS.includes(c.length))) {
        expect([longer, isGtin(longer)]).toEqual([longer, false])
      }
    }
  })

  it('AC-1: property: a GTIN with a space, a hyphen or a letter put anywhere in it is not a GTIN', () => {
    fc.assert(
      fc.property(
        fc.oneof(gtin, fc.constantFrom(...GTINS)),
        fc.nat(),
        fc.constantFrom(' ', '-', 'a', 'X', '\t'),
        (code, at, inserted) => {
          const i = at % (code.length + 1)
          const spoiled = `${code.slice(0, i)}${inserted}${code.slice(i)}`
          expect([isGtin(code), isGtin(spoiled)], JSON.stringify(spoiled)).toEqual([true, false])
        },
      ),
      { numRuns: 300 },
    )
  })
})
