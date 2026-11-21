import type { Address, ShippingOption } from '@nymbalhq/types'

/** A row of `commerce.shipping.rates`. */
export interface ShippingRate {
  id: string
  name: string
  countries?: readonly string[] | undefined
  amountMinor: number
  freeOverMinor?: number | undefined
  estimatedDays?: number | undefined
}

/** What a store with no table offers every address: one free option. */
export const STANDARD_OPTION: ShippingOption = {
  id: 'standard',
  name: 'Standard',
  amountMinor: 0,
  estimatedDays: null,
}

/**
 * The options the table offers an address, in the table's order: the rows naming its country, else the rows naming
 * none, else none (the store does not ship there). Each is free when the goods after discount reach its threshold.
 */
export function shippingOptions(
  rates: readonly ShippingRate[],
  shipTo: Address,
  goodsMinor: number,
): ShippingOption[] {
  if (rates.length === 0) return [{ ...STANDARD_OPTION }]
  const country = shipTo.country.trim().toUpperCase()
  const naming = rates.filter((row) => row.countries?.includes(country) === true)
  const rows = naming.length > 0 ? naming : rates.filter((row) => row.countries === undefined)
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    amountMinor:
      row.freeOverMinor !== undefined && row.freeOverMinor <= goodsMinor ? 0 : row.amountMinor,
    estimatedDays: row.estimatedDays ?? null,
  }))
}
