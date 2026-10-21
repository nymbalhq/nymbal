import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareDocumentValues, matchesSortKey } from './document-order.js'

// Acceptance tests for P2-02 AC-2 (spec P2-02-primitives-are-protocols), the reference half: compareDocumentValues and
// matchesSortKey are the one model every document store is held to (decision 3). Strings compare with Intl.Collator at
// base sensitivity, numbers numerically; values of different types rank by type first (number, then string, then any
// other type, then null and missing), so the order is total and antisymmetric (R1); `eq` is `===`, and `gt`, `lt` and
// `between` are compareDocumentValues. Kills: today's compare, which returns 1 both ways for 1 and '1'; byte order for
// strings; a text `eq` that matches 1 against '1'; nulls ranked first.

const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0)

/** Decision 3's generator domain: case, accent and equal-base strings, ints and numeric strings, null and missing. */
const strings = fc.oneof(
  fc.constantFrom('a', 'A', 'á', 'b', 'B', 'e', 'é', 'E', 'ab', 'Ab', 'áb', '1', '10', '2', '01'),
  fc.string({ maxLength: 4 }),
)
const ints = fc.integer({ min: -3, max: 12 })
const nullish = fc.constantFrom(null, undefined)
/** A type that is neither number, string nor null: it ranks after strings and before null. */
const others = fc.boolean()
const value = fc.oneof(strings, ints, nullish, others)

/** A sortKey condition, as QueryParams carries it; a variable, so either typing of the parameter accepts it. */
function on(operator: 'eq' | 'gt' | 'lt' | 'between', target: unknown) {
  return { field: 'f', operator, value: target }
}

type Rank = 0 | 1 | 2 | 3
function rankOf(v: unknown): Rank {
  if (typeof v === 'number') return 0
  if (typeof v === 'string') return 1
  if (v === null || v === undefined) return 3
  return 2
}

describe('P2-02 AC-2: compareDocumentValues is a total order over the generator domain', () => {
  it('AC-2: antisymmetric: compare(a, b) and compare(b, a) have opposite signs, for every pair (1 and "1" included)', () => {
    fc.assert(
      fc.property(value, value, (a, b) => {
        expect(sign(compareDocumentValues(a, b)) + sign(compareDocumentValues(b, a))).toBe(0)
      }),
      { numRuns: 500 },
    )
    expect(compareDocumentValues(1, '1')).toBeLessThan(0)
    expect(compareDocumentValues('1', 1)).toBeGreaterThan(0)
  })

  it('AC-2: transitive: a ≤ b and b ≤ c give a ≤ c', () => {
    fc.assert(
      fc.property(value, value, value, (a, b, c) => {
        fc.pre(compareDocumentValues(a, b) <= 0 && compareDocumentValues(b, c) <= 0)
        expect(compareDocumentValues(a, c)).toBeLessThanOrEqual(0)
      }),
      { numRuns: 1000 },
    )
  })

  it('AC-2: different types rank by type first: number, then string, then any other type, then null and missing', () => {
    fc.assert(
      fc.property(value, value, (a, b) => {
        fc.pre(rankOf(a) !== rankOf(b))
        expect(sign(compareDocumentValues(a, b))).toBe(sign(rankOf(a) - rankOf(b)))
      }),
      { numRuns: 500 },
    )
  })

  it('AC-2: numbers compare numerically, and strings by Intl.Collator at base sensitivity (a, A and á tie)', () => {
    fc.assert(
      fc.property(ints, ints, (m, n) => {
        expect(sign(compareDocumentValues(m, n))).toBe(sign(m - n))
      }),
    )
    fc.assert(
      fc.property(strings, strings, (s, t) => {
        expect(sign(compareDocumentValues(s, t))).toBe(sign(collator.compare(s, t)))
      }),
      { numRuns: 500 },
    )
    expect(compareDocumentValues('a', 'A')).toBe(0)
    expect(compareDocumentValues('á', 'a')).toBe(0)
    // Byte order puts '10' before '9' and 'B' before 'a'; the collator agrees on the first and not the second.
    expect(sign(compareDocumentValues('B', 'a'))).toBe(sign(collator.compare('B', 'a')))
  })
})

describe('P2-02 AC-2: matchesSortKey is === for eq and compareDocumentValues for gt, lt and between', () => {
  it('AC-2: eq matches exactly the strictly equal values: 1 is not "1", and "a" is not "A"', () => {
    fc.assert(
      fc.property(value, value, (v, target) => {
        expect(matchesSortKey(v, on('eq', target))).toBe(v === target)
      }),
      { numRuns: 500 },
    )
    expect(matchesSortKey(1, on('eq', '1'))).toBe(false)
    expect(matchesSortKey('a', on('eq', 'A'))).toBe(false)
  })

  it('AC-2: gt, lt and between agree with compareDocumentValues for every value and bound', () => {
    fc.assert(
      fc.property(value, value, value, (v, low, high) => {
        expect(matchesSortKey(v, on('gt', low))).toBe(compareDocumentValues(v, low) > 0)
        expect(matchesSortKey(v, on('lt', low))).toBe(compareDocumentValues(v, low) < 0)
        expect(matchesSortKey(v, on('between', [low, high]))).toBe(
          compareDocumentValues(v, low) >= 0 && compareDocumentValues(v, high) <= 0,
        )
      }),
      { numRuns: 1000 },
    )
  })
})
