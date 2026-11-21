import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CheckoutTotalsLine, PromotionEffect, TotalsLine, TotalsTax } from '@nymbalhq/types'
import { settleTotals } from './totals.js'

// The one function every total comes from. AC-1's equations hold for any effect list an engine can return, hostile
// ones included; AC-2 holds an order effect's allocation to an independent largest-remainder oracle; AC-3 pins the
// no-promotion regression and the re-settle of a function's own output.

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0)

const arbLines: fc.Arbitrary<TotalsLine[]> = fc
  .uniqueArray(
    fc.record({
      id: fc.uuid(),
      unitMinor: fc.integer({ min: 0, max: 100_000 }),
      qty: fc.integer({ min: 1, max: 50 }),
    }),
    { minLength: 1, maxLength: 6, selector: (line) => line.id },
  )
  .map((lines) => lines)

/** An amount an engine has no business returning, and one it might. */
const arbAmount = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 200_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: -200_000, max: -1 }) },
  { weight: 1, arbitrary: fc.double({ min: -1000, max: 1000, noNaN: true }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      1e15,
      -0,
    ),
  },
)

function arbEffect(lineIds: readonly string[]): fc.Arbitrary<PromotionEffect> {
  const lineId = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...lineIds) },
    { weight: 1, arbitrary: fc.constantFrom('no-such-line', '') },
  )
  return fc.oneof(
    fc.record({
      kind: fc.constant('line' as const),
      lineId,
      amountMinor: arbAmount,
      label: fc.constant('line'),
    }),
    fc.record({
      kind: fc.constant('order' as const),
      amountMinor: arbAmount,
      label: fc.constant('order'),
    }),
    fc.record({
      kind: fc.constant('shipping' as const),
      amountMinor: arbAmount,
      label: fc.constant('shipping'),
    }),
    fc.record({ kind: fc.constant('code_accepted' as const), code: fc.constant('C') }),
    fc.record({
      kind: fc.constant('code_rejected' as const),
      code: fc.constant('C'),
      reason: fc.constant('unknown'),
    }),
    fc.record({ kind: fc.constant('notice' as const), text: fc.constant('n') }),
    fc.record({ kind: fc.constant('unsupported' as const), detail: fc.constant('d') }),
  )
}

/** Effects over these lines, a generated tail of them repeated: an engine may answer the same effect twice. */
function arbEffects(lines: readonly TotalsLine[]): fc.Arbitrary<PromotionEffect[]> {
  return fc
    .tuple(fc.array(arbEffect(lines.map((line) => line.id)), { maxLength: 12 }), fc.nat({ max: 3 }))
    .map(([effects, repeated]) => [...effects, ...effects.slice(0, repeated)])
}

function arbTax(lines: readonly TotalsLine[]): fc.Arbitrary<TotalsTax | null> {
  return fc.option(
    fc.record({
      lines: fc
        .constant(lines)
        .chain((all) =>
          fc
            .tuple(...all.map(() => fc.integer({ min: 0, max: 10_000 })))
            .map((taxes) => all.map((line, i) => ({ id: line.id, taxMinor: taxes[i]! }))),
        ),
      shippingTaxMinor: fc.integer({ min: 0, max: 5_000 }),
    }),
    { nil: null },
  )
}

const arbInput = arbLines.chain((lines) =>
  fc.record({
    currency: fc.constantFrom('GBP', 'USD', 'EUR'),
    lines: fc.constant(lines),
    shipping: fc.option(fc.record({ amountMinor: fc.integer({ min: 0, max: 50_000 }) }), {
      nil: null,
    }),
    effects: arbEffects(lines),
    tax: arbTax(lines),
    pricesIncludeTax: fc.boolean(),
  }),
)

const isNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

describe('AC-1: the totals invariant', () => {
  it('AC-1: over arbitrary lines, shipping, tax, inclusive flag and hostile effects, the totals add up, the clamps hold and every amount is a non-negative integer', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const totals = settleTotals(input)
        const inclusive = input.pricesIncludeTax
        const shippingTax = input.tax?.shippingTaxMinor ?? 0
        const lineSubtotal = (id: string): number => {
          const line = input.lines.find((l) => l.id === id)!
          return line.unitMinor * line.qty
        }

        expect(totals.subtotalMinor).toBe(sum(input.lines.map((l) => l.unitMinor * l.qty)))
        expect(totals.totalMinor).toBe(
          totals.subtotalMinor -
            totals.discountTotalMinor +
            totals.shippingTotalMinor +
            (inclusive ? 0 : totals.taxTotalMinor),
        )
        expect(totals.discountTotalMinor).toBeGreaterThanOrEqual(0)
        expect(totals.discountTotalMinor).toBeLessThanOrEqual(
          totals.subtotalMinor + totals.shippingTotalMinor,
        )
        expect(totals.lines.map((l: CheckoutTotalsLine) => l.id).sort()).toEqual(
          input.lines.map((l) => l.id).sort(),
        )
        for (const line of totals.lines) {
          expect(line.subtotalMinor).toBe(lineSubtotal(line.id))
          expect(line.discountMinor).toBeGreaterThanOrEqual(0)
          expect(line.discountMinor).toBeLessThanOrEqual(line.subtotalMinor)
        }
        expect(sum(totals.lines.map((l: CheckoutTotalsLine) => l.discountMinor))).toBe(
          totals.discountTotalMinor - totals.shippingDiscountMinor,
        )
        expect(
          sum(totals.lines.map((l: CheckoutTotalsLine) => l.totalMinor)) +
            totals.shippingTotalMinor -
            totals.shippingDiscountMinor +
            (inclusive ? 0 : shippingTax),
        ).toBe(totals.totalMinor)

        for (const amount of [
          totals.subtotalMinor,
          totals.discountTotalMinor,
          totals.shippingTotalMinor,
          totals.shippingDiscountMinor,
          totals.taxTotalMinor,
          totals.totalMinor,
          ...totals.lines.flatMap((l: CheckoutTotalsLine) => [
            l.subtotalMinor,
            l.discountMinor,
            l.taxMinor,
            l.totalMinor,
          ]),
        ]) {
          expect(isNonNegativeInteger(amount), String(amount)).toBe(true)
        }
      }),
      { numRuns: 500 },
    )
  })
})

/** Largest remainder over the lines' subtotals; ties to the lower index. */
function largestRemainder(amount: number, weights: readonly number[]): number[] {
  const whole = sum(weights)
  if (whole === 0) return weights.map(() => 0)
  const floors = weights.map((w) => Number((BigInt(amount) * BigInt(w)) / BigInt(whole)))
  const remainders = weights.map((w, index) => ({
    index,
    remainder: (BigInt(amount) * BigInt(w)) % BigInt(whole),
  }))
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  )
  const left = amount - sum(floors)
  for (let i = 0; i < left; i += 1) floors[remainders[i]!.index]! += 1
  return floors
}

describe('AC-2: an order effect is allocated to the lines', () => {
  it('AC-2: the allocation is the largest-remainder split of the clamped amount: it sums exactly, each share is within one unit, ties go to the lower index and the same input gives the same allocation', () => {
    fc.assert(
      fc.property(
        arbLines.filter((lines) => sum(lines.map((l) => l.unitMinor * l.qty)) > 0),
        fc.integer({ min: 0, max: 20_000_000 }),
        (lines, amount) => {
          const input = {
            currency: 'GBP',
            lines,
            shipping: null,
            tax: null,
            pricesIncludeTax: false,
            effects: [{ kind: 'order', amountMinor: amount, label: 'order' }] as PromotionEffect[],
          }
          const weights = lines.map((l) => l.unitMinor * l.qty)
          const subtotal = sum(weights)
          const clamped = Math.min(amount, subtotal)

          const totals = settleTotals(input)
          const allocated = input.lines.map(
            (l) => totals.lines.find((t: CheckoutTotalsLine) => t.id === l.id)!.discountMinor,
          )

          expect(sum(allocated)).toBe(clamped)
          expect(allocated).toEqual(largestRemainder(clamped, weights))
          weights.forEach((weight, i) => {
            const distance =
              BigInt(allocated[i]!) * BigInt(subtotal) - BigInt(clamped) * BigInt(weight)
            const absolute = distance < 0n ? -distance : distance
            expect(absolute <= BigInt(subtotal), `line ${i}`).toBe(true)
          })
          expect(settleTotals(input).lines).toEqual(totals.lines)
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe('AC-3: the regression anchor and idempotence', () => {
  it('AC-3: with no effects, shipping or tax the totals are today’s: the subtotal is the sum of the lines, no discount, each line’s total its subtotal', () => {
    fc.assert(
      fc.property(arbLines, (lines) => {
        const totals = settleTotals({
          currency: 'GBP',
          lines,
          shipping: null,
          effects: [],
          tax: null,
          pricesIncludeTax: false,
        })

        const subtotal = sum(lines.map((l) => l.unitMinor * l.qty))
        expect(totals.subtotalMinor).toBe(subtotal)
        expect(totals.totalMinor).toBe(subtotal)
        expect(totals.discountTotalMinor).toBe(0)
        expect(totals.applied).toEqual([])
        for (const line of totals.lines) {
          expect(line.totalMinor).toBe(line.subtotalMinor)
          expect(line.discountMinor).toBe(0)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('AC-3: settling a settlement’s own applied effects returns the same totals, and the applied amounts are the discount that counted', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const first = settleTotals(input)
        const again = settleTotals({ ...input, effects: first.applied })

        expect(again).toEqual(first)
        expect(
          first.applied.every((e: PromotionEffect) =>
            ['line', 'order', 'shipping'].includes(e.kind),
          ),
        ).toBe(true)
        expect(
          sum(
            first.applied.map((e: PromotionEffect) => (e as { amountMinor: number }).amountMinor),
          ),
        ).toBe(first.discountTotalMinor)
      }),
      { numRuns: 500 },
    )
  })
})
