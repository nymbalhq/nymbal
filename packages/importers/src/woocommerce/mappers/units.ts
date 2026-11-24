// WooCommerce's unit settings (woocommerce_weight_unit, woocommerce_dimension_unit); Nymbal holds grams and millimetres.
export type WeightUnit = 'kg' | 'g' | 'lbs' | 'oz'
export type DimensionUnit = 'm' | 'cm' | 'mm' | 'in' | 'yd'

const GRAMS_PER: Readonly<Record<WeightUnit, number>> = {
  kg: 1000,
  g: 1,
  lbs: 453.59237,
  oz: 28.349523125,
}

const MILLIMETRES_PER: Readonly<Record<DimensionUnit, number>> = {
  m: 1000,
  cm: 10,
  mm: 1,
  in: 25.4,
  yd: 914.4,
}

/** The heaviest weight the store holds. */
export const MAX_GRAMS = 1_000_000

/** The value in whole target units; null when it is empty, not positive or above `max`. */
function convert(value: string, factor: number, max = Infinity): number | null {
  const n = Number(value)
  const converted = Math.round(n * factor)
  return n > 0 && converted <= max ? converted : null
}

export function toGrams(value: string, unit: WeightUnit): number | null {
  return convert(value, GRAMS_PER[unit], MAX_GRAMS)
}

export function toMillimetres(value: string, unit: DimensionUnit): number | null {
  return convert(value, MILLIMETRES_PER[unit])
}
