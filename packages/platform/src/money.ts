/**
 * An amount in the currency's own minor units as money, the way the admin shows it: 1999 GBP is £19.99,
 * 1999 JPY is ¥1,999.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase()
  const format = new Intl.NumberFormat('en-GB', { style: 'currency', currency: code })
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2
  return format.format(amountMinor / 10 ** digits)
}
