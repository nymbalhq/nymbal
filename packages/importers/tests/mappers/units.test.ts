import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { toGrams, toMillimetres } from '../../src/woocommerce/mappers/units.js'
import { mapProduct, productWarnings } from '../../src/woocommerce/mappers/product.js'
import { storeContext, wcProduct, wcVariable, wcVariation } from './support/wc.js'

// WooCommerce stores weight in kg|g|lbs|oz and dimensions in m|cm|mm|in|yd (woocommerce_weight_unit,
// woocommerce_dimension_unit); Nymbal holds whole grams and millimetres.

const GRAMS = { kg: 1000, g: 1, lbs: 453.59237, oz: 28.349523125 } as const
const MILLIMETRES = { m: 1000, cm: 10, mm: 1, in: 25.4, yd: 914.4 } as const
/** The heaviest weight the store holds, in grams. */
const HEAVIEST = 1_000_000
type WeightUnit = keyof typeof GRAMS
type DimensionUnit = keyof typeof MILLIMETRES

/** A positive decimal string with up to three fraction digits, as a merchant types it. */
const amount = fc
  .tuple(
    fc.integer({ min: 0, max: 5000 }),
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 3 }),
  )
  .filter(([whole, frac, digits]) => whole > 0 || (digits > 0 && frac % 10 ** digits > 0))
  .map(([whole, frac, digits]) =>
    digits === 0 ? String(whole) : `${whole}.${String(frac % 10 ** digits).padStart(digits, '0')}`,
  )

describe('toGrams and toMillimetres', () => {
  it('AC-4: property: a weight converts by its unit’s factor to the nearest whole gram', () => {
    fc.assert(
      fc.property(
        amount,
        fc.constantFrom(...(Object.keys(GRAMS) as WeightUnit[])),
        (value, unit) => {
          const exact = Number(value) * GRAMS[unit]
          // Under one gram or millimetre, whether 0 or null comes back is not the point of these properties; over
          // the store's heaviest weight is the bound's own test.
          fc.pre(exact >= 1 && exact <= HEAVIEST)
          const grams = toGrams(value, unit)
          expect(Number.isInteger(grams), `${value} ${unit} → ${grams}`).toBe(true)
          expect(Math.abs(grams! - exact), `${value} ${unit} → ${grams}`).toBeLessThanOrEqual(
            0.5 + 1e-9,
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  it('AC-4: property: a dimension converts by its unit’s factor to the nearest whole millimetre', () => {
    fc.assert(
      fc.property(
        amount,
        fc.constantFrom(...(Object.keys(MILLIMETRES) as DimensionUnit[])),
        (value, unit) => {
          const exact = Number(value) * MILLIMETRES[unit]
          fc.pre(exact >= 1)
          const mm = toMillimetres(value, unit)
          expect(Number.isInteger(mm), `${value} ${unit} → ${mm}`).toBe(true)
          expect(Math.abs(mm! - exact), `${value} ${unit} → ${mm}`).toBeLessThanOrEqual(0.5 + 1e-9)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('AC-4: each factor is the one WooCommerce’s unit means', () => {
    expect(toGrams('1', 'kg')).toBe(1000)
    expect(toGrams('250', 'g')).toBe(250)
    expect(toGrams('1', 'lbs')).toBe(454)
    expect(toGrams('0.25', 'lbs')).toBe(113)
    expect(toGrams('1', 'oz')).toBe(28)
    expect(toGrams('16', 'oz')).toBe(454)
    expect(toMillimetres('1.2', 'm')).toBe(1200)
    expect(toMillimetres('4.5', 'cm')).toBe(45)
    expect(toMillimetres('7', 'mm')).toBe(7)
    expect(toMillimetres('4.7', 'in')).toBe(119)
    expect(toMillimetres('1', 'yd')).toBe(914)
  })

  it('AC-4: an empty, unparseable, zero or negative value is null', () => {
    for (const value of ['', 'abc', '0', '0.0', '-1', '-0.5']) {
      expect(toGrams(value, 'kg'), JSON.stringify(value)).toBeNull()
      expect(toMillimetres(value, 'cm'), JSON.stringify(value)).toBeNull()
    }
  })
})

describe('a weight heavier than the store holds', () => {
  it('maps to null above 1,000,000 g and to itself at it, in every unit', () => {
    expect(toGrams('1000', 'kg')).toBe(1_000_000)
    expect(toGrams('1000000', 'g')).toBe(1_000_000)
    expect(toGrams('1500', 'kg')).toBeNull()
    expect(toGrams('1000001', 'g')).toBeNull()
    expect(toGrams('2205', 'lbs')).toBeNull()
    expect(toGrams('35273', 'oz')).toBe(999_973)
    expect(toGrams('35274', 'oz')).toBeNull()
  })

  it('property: a converted weight is never above 1,000,000 g', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.constantFrom(...(Object.keys(GRAMS) as WeightUnit[])),
        (value, unit) => {
          const grams = toGrams(String(value), unit)
          const exact = Math.round(value * GRAMS[unit])
          expect(grams, `${value} ${unit}`).toBe(exact <= HEAVIEST ? exact : null)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('a simple product weighing 1500 kg imports with no weight and warns with the weight it had; 1000 kg imports as is with no warning', () => {
    const store = storeContext({ weightUnit: 'kg' })
    const heavy = wcProduct({ weight: '1500' })
    expect(mapProduct(heavy, [], [], [], '', store).variants![0]!.weightGrams).toBeNull()
    expect(productWarnings(heavy, [], store).filter((w) => w.includes('weight'))).toEqual([
      'weight 1500 kg is over 1,000,000 g: imported with no weight',
    ])

    const limit = wcProduct({ weight: '1000' })
    expect(mapProduct(limit, [], [], [], '', store).variants![0]!.weightGrams).toBe(1_000_000)
    expect(productWarnings(limit, [], store).filter((w) => w.includes('weight'))).toEqual([])
  })

  it('a variation weighing 1,000,001 g imports with no weight and warns under its id, its sibling keeping its weight', () => {
    const store = storeContext({ weightUnit: 'g' })
    const heavy = wcVariation({ id: 21, sku: 'V-HEAVY', weight: '1000001' })
    const light = wcVariation({ id: 22, sku: 'V-LIGHT', weight: '250' })
    const wc = wcVariable([heavy, light], {
      weight: '',
      dimensions: { length: '', width: '', height: '' },
    })
    const bySku = new Map(
      mapProduct(wc, [heavy, light], [], [], '', store).variants!.map((v) => [
        v.sku,
        v.weightGrams,
      ]),
    )
    expect(Object.fromEntries(bySku)).toEqual({ 'V-HEAVY': null, 'V-LIGHT': 250 })
    expect(productWarnings(wc, [heavy, light], store).filter((w) => w.includes('weight'))).toEqual([
      'variation 21: weight 1000001 g is over 1,000,000 g: imported with no weight',
    ])
  })
})

describe('mapProduct in the store’s units', () => {
  it('AC-4: property: a simple product’s weight and dimensions convert from the store’s units, not from kg and cm', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(GRAMS) as WeightUnit[])),
        fc.constantFrom(...(Object.keys(MILLIMETRES) as DimensionUnit[])),
        amount,
        fc.tuple(amount, amount, amount),
        (weightUnit, dimensionUnit, weight, [length, width, height]) => {
          fc.pre(Number(weight) * GRAMS[weightUnit] >= 1)
          fc.pre(Number(weight) * GRAMS[weightUnit] <= HEAVIEST)
          fc.pre([length, width, height].every((d) => Number(d) * MILLIMETRES[dimensionUnit] >= 1))
          const variant = mapProduct(
            wcProduct({ weight, dimensions: { length, width, height } }),
            [],
            [],
            [],
            '',
            storeContext({ weightUnit, dimensionUnit }),
          ).variants![0]!
          const near = (actual: number | undefined, value: string, factor: number) =>
            Math.abs((actual ?? Number.NaN) - Number(value) * factor) <= 0.5 + 1e-9
          expect(near(variant.weightGrams ?? undefined, weight, GRAMS[weightUnit])).toBe(true)
          const d = variant.dimensions
          expect([
            near(d?.lengthMm, length, MILLIMETRES[dimensionUnit]),
            near(d?.widthMm, width, MILLIMETRES[dimensionUnit]),
            near(d?.heightMm, height, MILLIMETRES[dimensionUnit]),
          ]).toEqual([true, true, true])
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-4: a store in lbs and in imports 2 lbs as 907 g and 4.7 × 4.7 × 3.1 in as 119 × 119 × 79 mm', () => {
    const variant = mapProduct(
      wcProduct({ weight: '2', dimensions: { length: '4.7', width: '4.7', height: '3.1' } }),
      [],
      [],
      [],
      '',
      storeContext({ currency: 'JPY', weightUnit: 'lbs', dimensionUnit: 'in' }),
    ).variants![0]!
    expect(variant.weightGrams).toBe(907)
    expect(variant.dimensions).toEqual({ lengthMm: 119, widthMm: 119, heightMm: 79 })
  })

  it('AC-4: one empty dimension is left out and the other two are kept', () => {
    const variant = mapProduct(
      wcProduct({ dimensions: { length: '45', width: '45', height: '' } }),
      [],
      [],
      [],
      '',
      storeContext(),
    ).variants![0]!
    expect(variant.dimensions).toEqual({ lengthMm: 450, widthMm: 450 })
  })

  it('AC-4: a variation’s empty weight and dimensions take the parent’s, and its own values win where it has them', () => {
    const parent = { weight: '0.5', dimensions: { length: '70', width: '50', height: '1' } }
    const inherits = wcVariation({
      id: 11,
      sku: 'V-INHERITS',
      weight: '',
      dimensions: { length: '', width: '', height: '' },
    })
    const partly = wcVariation({
      id: 12,
      sku: 'V-PARTLY',
      weight: '0.25',
      dimensions: { length: '72', width: '', height: '' },
    })
    const product = mapProduct(
      wcVariable([inherits, partly], parent),
      [inherits, partly],
      [],
      [],
      '',
      storeContext(),
    )
    const bySku = new Map(product.variants!.map((v) => [v.sku, v]))
    expect(bySku.get('V-INHERITS')!.weightGrams).toBe(500)
    expect(bySku.get('V-INHERITS')!.dimensions).toEqual({
      lengthMm: 700,
      widthMm: 500,
      heightMm: 10,
    })
    expect(bySku.get('V-PARTLY')!.weightGrams).toBe(250)
    expect(bySku.get('V-PARTLY')!.dimensions).toEqual({ lengthMm: 720, widthMm: 500, heightMm: 10 })
  })
})
