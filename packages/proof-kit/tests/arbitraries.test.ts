import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CURRENCY_EXPONENTS,
  arbCart,
  arbCurrency,
  arbEventSequence,
  arbMoney,
  arbOrderPath,
  arbOrderTransition,
} from '@nymbalhq/proof-kit/arbitraries'
import {
  ORDER_STATUS_TRANSITIONS,
  canTransitionOrder,
  sumMoney,
  type NymbalEvent,
  type OrderStatus,
} from '@nymbalhq/types'

// Acceptance tests for P1-01 AC-14 (money and carts), AC-15 (order paths and transitions) and AC-16 (event
// sequences): the arbitraries every kernel property test will draw from, 500 runs each.

const RUNS = 500
const STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]

/** Every event type constant in packages/types/src/events/constants.ts, read from the source. */
const CONSTANT_TYPES = new Set(
  [
    ...readFileSync(
      new URL('../../types/src/events/constants.ts', import.meta.url),
      'utf8',
    ).matchAll(/export const EVT_\w+ = '([^']+)'/g),
  ].map((m) => m[1]!),
)

const exponentOf = (currency: string): number | undefined =>
  Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency)
    ? CURRENCY_EXPONENTS[currency]
    : undefined

describe('AC-14: money and cart arbitraries', () => {
  it('AC-14: CURRENCY_EXPONENTS holds at least JPY, KRW (0); GBP, USD, EUR (2); KWD, BHD (3), and arbCurrency draws only its keys', () => {
    expect(CURRENCY_EXPONENTS).toMatchObject({
      JPY: 0,
      KRW: 0,
      GBP: 2,
      USD: 2,
      EUR: 2,
      KWD: 3,
      BHD: 3,
    })
    fc.assert(
      fc.property(arbCurrency(), (currency) => {
        expect([0, 2, 3]).toContain(exponentOf(currency))
      }),
      { numRuns: RUNS },
    )
  })

  it('AC-14: every arbMoney amount is a safe integer and its currency a key of CURRENCY_EXPONENTS; exponents 0, 2 and 3 all appear', () => {
    const exponents = new Set<number | undefined>()
    fc.assert(
      fc.property(arbMoney(), (m) => {
        exponents.add(exponentOf(m.currency))
        expect(Number.isSafeInteger(m.amount)).toBe(true)
        expect(exponentOf(m.currency)).not.toBeUndefined()
      }),
      { numRuns: RUNS },
    )
    expect([...exponents].sort()).toEqual([0, 2, 3])
  })

  it('AC-14: arbMoney({ min, max }) stays within [min, max], and arbMoney({ currency }) keeps that currency', () => {
    const bound = fc.oneof(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.constantFrom(0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER),
    )
    const bounded = fc
      .tuple(bound, bound, fc.constantFrom(...Object.keys(CURRENCY_EXPONENTS)))
      .chain(([a, b, currency]) => {
        const [min, max] = a <= b ? [a, b] : [b, a]
        return arbMoney({ currency, min, max }).map((m) => ({ m, min, max, currency }))
      })
    fc.assert(
      fc.property(bounded, ({ m, min, max, currency }) => {
        expect(Number.isSafeInteger(m.amount)).toBe(true)
        expect(m.amount).toBeGreaterThanOrEqual(min)
        expect(m.amount).toBeLessThanOrEqual(max)
        expect(m.currency).toBe(currency)
      }),
      { numRuns: RUNS },
    )
  })

  it('AC-14: every arbCart line has qty >= 1 and unitPriceMinor >= 0, and sumMoney of its line totals equals the exact sum, without overflow', () => {
    const currencies = new Set<string>()
    fc.assert(
      fc.property(arbCart(), (cart) => {
        currencies.add(cart.currency)
        expect(exponentOf(cart.currency)).not.toBeUndefined()
        let exact = 0n
        for (const line of cart.lines) {
          expect(Number.isSafeInteger(line.qty) && line.qty >= 1).toBe(true)
          expect(Number.isSafeInteger(line.unitPriceMinor) && line.unitPriceMinor >= 0).toBe(true)
          exact += BigInt(line.unitPriceMinor) * BigInt(line.qty)
        }
        const total = sumMoney(
          cart.lines.map((l) => ({ amount: l.unitPriceMinor * l.qty, currency: cart.currency })),
          cart.currency,
        )
        expect(Number.isSafeInteger(total.amount)).toBe(true)
        expect(BigInt(total.amount)).toBe(exact)
        expect(total.currency).toBe(cart.currency)
      }),
      { numRuns: RUNS },
    )
    expect(currencies.size).toBeGreaterThan(1)
  })

  it('AC-14: arbCart({ currency }) draws carts in that one currency', () => {
    fc.assert(
      fc.property(
        fc
          .constantFrom(...Object.keys(CURRENCY_EXPONENTS))
          .chain((currency) => arbCart({ currency }).map((cart) => ({ cart, currency }))),
        ({ cart, currency }) => {
          expect(cart.currency).toBe(currency)
        },
      ),
      { numRuns: RUNS },
    )
  })
})

describe('AC-15: order path and transition arbitraries', () => {
  it('AC-15: every adjacent pair of an arbOrderPath satisfies canTransitionOrder, and every OrderStatus appears across the runs', () => {
    const seen = new Set<OrderStatus>()
    fc.assert(
      fc.property(arbOrderPath(), (path) => {
        for (const status of path) seen.add(status)
        for (let i = 1; i < path.length; i += 1) {
          expect(canTransitionOrder(path[i - 1]!, path[i]!)).toBe(true)
        }
      }),
      { numRuns: RUNS },
    )
    expect([...seen].sort()).toEqual([...STATUSES].sort())
  })

  it('AC-15: arbOrderTransition({ valid: true }) always satisfies canTransitionOrder; { valid: false } never does', () => {
    fc.assert(
      fc.property(arbOrderTransition({ valid: true }), ({ from, to }) => {
        expect(canTransitionOrder(from, to)).toBe(true)
      }),
      { numRuns: RUNS },
    )
    fc.assert(
      fc.property(arbOrderTransition({ valid: false }), ({ from, to }) => {
        expect(STATUSES).toContain(from)
        expect(STATUSES).toContain(to)
        expect(canTransitionOrder(from, to)).toBe(false)
      }),
      { numRuns: RUNS },
    )
  })
})

const ids = (seq: NymbalEvent[]): string[] => seq.map((e) => e.id)
const times = (seq: NymbalEvent[]): number[] => seq.map((e) => Date.parse(e.timestamp))

describe('AC-16: event sequence arbitraries', () => {
  it('AC-16: by default, types come from every constant in events/constants.ts, ids are unique and timestamps non-decreasing', () => {
    expect(CONSTANT_TYPES.size).toBeGreaterThan(30)
    const types = new Set<string>()
    fc.assert(
      fc.property(arbEventSequence({ maxLength: 20 }), (seq) => {
        for (const e of seq) {
          types.add(e.type)
          expect(CONSTANT_TYPES.has(e.type)).toBe(true)
          expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false)
        }
        expect(new Set(ids(seq)).size).toBe(seq.length)
        const t = times(seq)
        for (let i = 1; i < t.length; i += 1) expect(t[i]!).toBeGreaterThanOrEqual(t[i - 1]!)
      }),
      { numRuns: RUNS },
    )
    expect([...types].sort()).toEqual([...CONSTANT_TYPES].sort())
  })

  it('AC-16: types are drawn from opts.types when given', () => {
    const given = ['proof.alpha.v1', 'proof.beta.v1', 'proof.gamma.v1']
    const types = new Set<string>()
    fc.assert(
      fc.property(arbEventSequence({ types: given }), (seq) => {
        for (const e of seq) {
          types.add(e.type)
          expect(given).toContain(e.type)
        }
      }),
      { numRuns: RUNS },
    )
    expect([...types].sort()).toEqual([...given].sort())
  })

  it('AC-16: duplicates: true yields a repeated id in every sequence of length >= 2', () => {
    let longEnough = 0
    fc.assert(
      fc.property(arbEventSequence({ duplicates: true }), (seq) => {
        if (seq.length >= 2) longEnough += 1
        expect(seq.length < 2 || new Set(ids(seq)).size < seq.length).toBe(true)
      }),
      { numRuns: RUNS },
    )
    expect(longEnough).toBeGreaterThan(0)
  })

  it('AC-16: shuffled: true yields at least one out-of-order timestamp across the runs', () => {
    let outOfOrder = 0
    fc.assert(
      fc.property(arbEventSequence({ shuffled: true }), (seq) => {
        const t = times(seq)
        if (t.some((value, i) => i > 0 && value < t[i - 1]!)) outOfOrder += 1
      }),
      { numRuns: RUNS },
    )
    expect(outOfOrder).toBeGreaterThan(0)
  })
})
