import { currencyExponent } from '@nymbalhq/types'

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/

/**
 * A WooCommerce amount (`"19.99"`, `"1500"`, `"-9.00"`) in `currency`'s minor units, read from its digits so no float
 * multiply can be off by one. Digits past the exponent round half up (away from zero). Null for an empty or
 * unparseable amount.
 */
export function toMinorUnits(amount: string | number, currency: string): number | null {
  const m = DECIMAL.exec(String(amount).trim())
  if (m === null) return null
  const whole = m[2] ?? ''
  const fraction = m[3] ?? ''
  if (whole === '' && fraction === '') return null
  const exp = currencyExponent(currency)
  const kept = fraction.slice(0, exp).padEnd(exp, '0')
  const roundsUp = (fraction[exp] ?? '0') >= '5'
  const magnitude = Number(`${whole}${kept}`) + (roundsUp ? 1 : 0)
  return m[1] === '-' && magnitude !== 0 ? -magnitude : magnitude
}
