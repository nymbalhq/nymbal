import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Address } from '@nymbalhq/types'
import { shippingOptions } from './shipping-quote.js'

// The native shipping table: which rows an address is offered, in the merchant's order, and what each costs for the
// goods in the cart. The oracle below is the rule as the store's documentation states it.

interface Row {
  id: string
  name: string
  countries?: string[]
  amountMinor: number
  freeOverMinor?: number
  estimatedDays?: number
}

const COUNTRIES = ['GB', 'FR', 'DE', 'US', 'IE'] as const

function addressIn(country: string): Address {
  return {
    firstName: 'Ada',
    lastName: 'Buyer',
    addressLine1: '1 Main St',
    city: 'Town',
    region: '',
    postalCode: '00000',
    country,
  }
}

const arbRow: fc.Arbitrary<Row> = fc.record(
  {
    id: fc.stringMatching(/^[a-z0-9_-]{1,12}$/),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    countries: fc.uniqueArray(fc.constantFrom(...COUNTRIES), { minLength: 1, maxLength: 3 }),
    amountMinor: fc.integer({ min: 0, max: 100_000 }),
    freeOverMinor: fc.integer({ min: 1, max: 200_000 }),
    estimatedDays: fc.integer({ min: 0, max: 30 }),
  },
  { requiredKeys: ['id', 'name', 'amountMinor'] },
)

const arbTable = fc.uniqueArray(arbRow, { minLength: 1, maxLength: 7, selector: (r) => r.id })

/** A country as a shopper may type it: any case, with spaces around. */
const arbTyped = fc
  .tuple(
    fc.constantFrom(...COUNTRIES, 'AU'),
    fc.boolean(),
    fc.constantFrom('', ' ', '  '),
    fc.constantFrom('', ' ', '\t'),
  )
  .map(([code, lower, before, after]) => ({
    code,
    typed: `${before}${lower ? code.toLowerCase() : code}${after}`,
  }))

const arbGoods = fc.integer({ min: 0, max: 250_000 })

/** The rule: the rows naming the country, else the rows naming none, else nothing; free from the threshold up. */
function oracle(rates: readonly Row[], country: string, goodsMinor: number) {
  const naming = rates.filter((r) => r.countries?.includes(country))
  const rows = naming.length > 0 ? naming : rates.filter((r) => r.countries === undefined)
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    amountMinor: r.freeOverMinor !== undefined && r.freeOverMinor <= goodsMinor ? 0 : r.amountMinor,
    estimatedDays: r.estimatedDays ?? null,
  }))
}

/** An option as the tests read it. */
interface Offered {
  id: string
  amountMinor: number
}

const FREE_STANDARD = [{ id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: null }]

describe('AC-2: native shipping options', () => {
  // Kills: a table-less store charging for or renaming the one free option ACP and the element already show.
  it('AC-2: property: with no table every address is offered exactly the free standard option', () => {
    fc.assert(
      fc.property(arbTyped, arbGoods, ({ typed }, goods) => {
        expect(shippingOptions([], addressIn(typed), goods)).toEqual(FREE_STANDARD)
      }),
      { numRuns: 200 },
    )
  })

  // Kills: rest-of-world rows offered beside a country's own, the table reordered, the threshold compared the wrong
  // way round (free below it, or charged exactly at it), a country typed in lower case or with spaces missing its row.
  it('AC-2: property: the rows naming the country, else the rows naming none, else none, in the table’s order, each free exactly when freeOverMinor ≤ goods', () => {
    fc.assert(
      fc.property(arbTable, arbTyped, arbGoods, (rates, { code, typed }, goods) => {
        const options = shippingOptions(rates, addressIn(typed), goods)
        expect(options).toEqual(oracle(rates, code, goods))
      }),
      { numRuns: 1000 },
    )
  })

  // Kills: a threshold that charges more as the basket grows (an inverted comparison), or an id set that changes
  // with the goods, so the shopper's chosen option disappears when a line is added.
  it('AC-2: property: raising the goods never raises an option’s amount and never changes which options are offered', () => {
    fc.assert(
      fc.property(
        arbTable,
        arbTyped,
        arbGoods,
        fc.integer({ min: 1, max: 100_000 }),
        (rates, { typed }, goods, more) => {
          const before = shippingOptions(rates, addressIn(typed), goods)
          const after = shippingOptions(rates, addressIn(typed), goods + more)
          expect(after.map((o: Offered) => o.id)).toEqual(before.map((o: Offered) => o.id))
          after.forEach((option: Offered, i: number) => {
            expect(option.amountMinor).toBeLessThanOrEqual(before[i]!.amountMinor)
          })
        },
      ),
      { numRuns: 500 },
    )
  })

  it('AC-2: a GB shopper is offered the GB rows only, a shopper elsewhere the rest-of-world row, and a country no row reaches nothing', () => {
    const rates: Row[] = [
      { id: 'uk-standard', name: 'Standard', countries: ['GB'], amountMinor: 0 },
      { id: 'world', name: 'International', amountMinor: 1500, estimatedDays: 10 },
      { id: 'uk-express', name: 'Express', countries: ['GB', 'IE'], amountMinor: 499 },
    ]
    expect(shippingOptions(rates, addressIn(' gb '), 1000).map((o: Offered) => o.id)).toEqual([
      'uk-standard',
      'uk-express',
    ])
    expect(shippingOptions(rates, addressIn('FR'), 1000)).toEqual([
      { id: 'world', name: 'International', amountMinor: 1500, estimatedDays: 10 },
    ])
    const gbOnly = rates.filter((r) => r.countries !== undefined)
    expect(shippingOptions(gbOnly, addressIn('FR'), 1000)).toEqual([])
  })

  it('AC-2: an option is free at exactly its threshold and charged one unit below it', () => {
    const rates: Row[] = [{ id: 'std', name: 'Standard', amountMinor: 399, freeOverMinor: 5000 }]
    expect(shippingOptions(rates, addressIn('GB'), 5000)[0]!.amountMinor).toBe(0)
    expect(shippingOptions(rates, addressIn('GB'), 4999)[0]!.amountMinor).toBe(399)
  })
})
