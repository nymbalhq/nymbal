/**
 * formatMoney(1234, 'GBP') -> '£12.34'
 * formatMoney(9999, 'USD') -> '$99.99'
 */
export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100)
}

/**
 * formatMoneyCompact(120000, 'GBP') -> '£1.2k'
 */
export function formatMoneyCompact(amountMinor: number, currency: string): string {
  const amount = amountMinor / 100
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
