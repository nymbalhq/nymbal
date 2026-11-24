import { currencyExponent } from '@nymbalhq/types'

/**
 * An amount in the currency's own minor units as money, with ISO 4217's digits for it: 1999 GBP is £19.99,
 * 1999 JPY is JP¥1,999, 1999 KWD is KWD 1.999.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase()
  const digits = currencyExponent(code)
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits)
}
