import { currencyExponent } from '@nymbalhq/types'

/**
 * An amount in the currency's minor units, with ISO 4217's digits for it, as the kernel shows it:
 * formatMoney(1234, 'GBP') -> '£12.34', formatMoney(1999, 'JPY') -> 'JP¥1,999'.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const digits = currencyExponent(currency)
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits)
}

/**
 * The text a money input shows for an amount: plain digits with exactly the currency's fraction digits, no symbol or
 * grouping. toMoneyInput(1999, 'GBP') -> '19.99', toMoneyInput(1999, 'JPY') -> '1999'.
 */
export function toMoneyInput(amountMinor: number, currency: string): string {
  const digits = currencyExponent(currency)
  const text = String(amountMinor).padStart(digits + 1, '0')
  if (digits === 0) return text
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`
}

/**
 * The minor units of an amount typed in major units, read from its digits so no float multiply can be off by one:
 * parseMoney('12.34', 'GBP') -> 1234, parseMoney('1.5', 'KWD') -> 1500. Null for anything that is not a non-negative
 * decimal with at most the currency's fraction digits.
 */
export function parseMoney(input: string, currency: string): number | null {
  const digits = currencyExponent(currency)
  const text = input.trim()
  const shape = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`)
  if (!shape.test(text)) return null
  const [whole = '0', fraction = ''] = text.split('.')
  return Number(whole + fraction.padEnd(digits, '0'))
}

/**
 * formatMoneyCompact(120000, 'GBP') -> '£1.2k', formatMoneyCompact(120000, 'JPY') -> 'JP¥120.0k'
 */
export function formatMoneyCompact(amountMinor: number, currency: string): string {
  const amount = amountMinor / 10 ** currencyExponent(currency)
  const symbol = getCurrencySymbol(currency)
  if (amount >= 1_000_000) {
    return `${symbol}${(amount / 1_000_000).toFixed(1)}M`
  }
  if (amount >= 1_000) {
    return `${symbol}${(amount / 1_000).toFixed(1)}k`
  }
  return formatMoney(amountMinor, currency)
}

function getCurrencySymbol(currency: string): string {
  try {
    const formatted = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(0)
    return formatted.replace(/[\d\s,]/g, '').trim()
  } catch {
    return currency
  }
}
