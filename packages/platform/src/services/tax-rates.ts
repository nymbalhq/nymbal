import { US_STATES } from '@nymbalhq/config'
import type { Address, TaxQuote, TaxQuoteParams } from '@nymbalhq/types'

// The native tax engine: a rate table in config, a row per jurisdiction the store collects in, and exact integer
// maths. Rates are parts per million; a product past 2^53 is computed in BigInt.

export interface TaxRate {
  country: string
  region?: string | undefined
  percent: number
  codes?: Record<string, number> | undefined
}

const MILLION = 1_000_000n

/** A percent with at most four decimals in parts per million: 7.25 is 72 500. */
export function ppmOf(percent: number): number {
  return Math.round(percent * 10_000)
}

/** Tax added on top of `amountMinor` at `ppm`: A × r / 10⁶, rounded half up. */
export function exclusiveTax(amountMinor: number, ppm: number): number {
  return Number((BigInt(amountMinor) * BigInt(ppm) + MILLION / 2n) / MILLION)
}

/** Tax held in `amountMinor` at `ppm`: A less its net A × 10⁶ / (10⁶ + r), the net rounded half up. */
export function inclusiveTax(amountMinor: number, ppm: number): number {
  const gross = MILLION + BigInt(ppm)
  const net = (2n * BigInt(amountMinor) * MILLION + gross) / (2n * gross)
  return amountMinor - Number(net)
}

/** A value trimmed and upper-cased; anything but a string (an address with no region) is `''`, which no row names. */
const fold = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : ''

const STATE_BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [fold(name), code]))

/** The address's region as a table row writes it: a US state's name is its code. */
function regionOf(country: string, region: unknown): string {
  const folded = fold(region)
  return country === 'US' ? (STATE_BY_NAME.get(folded) ?? folded) : folded
}

/** The row for the address's country and region, else its country's row with no region, else none. */
export function matchRate(rates: readonly TaxRate[], address: Address): TaxRate | null {
  const country = fold(address.country)
  const region = regionOf(country, address.region)
  const inCountry = rates.filter((row) => fold(row.country) === country)
  return (
    inCountry.find((row) => row.region !== undefined && fold(row.region) === region) ??
    inCountry.find((row) => row.region === undefined) ??
    null
  )
}

/** The row's rate for a tax code it lists (an own key, never one inherited from Object), else its percent. */
function percentFor(row: TaxRate, taxCode: string | undefined): number {
  if (taxCode !== undefined && row.codes !== undefined && Object.hasOwn(row.codes, taxCode)) {
    return row.codes[taxCode]!
  }
  return row.percent
}

/** The table's quote: each line taxed on its own amount at its code's rate, else its row's; 0 outside every row. */
export function quoteNative(rates: readonly TaxRate[], params: TaxQuoteParams): TaxQuote {
  const row = matchRate(rates, params.shipTo)
  const taxOf = params.pricesIncludeTax ? inclusiveTax : exclusiveTax
  const lines = params.lines.map((line) => {
    const percent = row === null ? 0 : percentFor(row, line.taxCode)
    const ratePpm = ppmOf(percent)
    return {
      id: line.id,
      taxableMinor: line.amountMinor,
      taxMinor: taxOf(line.amountMinor, ratePpm),
      ratePpm,
    }
  })
  const shippingTaxMinor = 0
  return {
    provider: 'native',
    inclusive: params.pricesIncludeTax,
    lines,
    shippingTaxMinor,
    totalTaxMinor: lines.reduce((sum, line) => sum + line.taxMinor, shippingTaxMinor),
  }
}
