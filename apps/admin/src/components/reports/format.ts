import type { ReportSectionWindow } from '@nymbalhq/types'
import { formatStoreDay } from '@/lib/dates'

const SOURCE_LABELS: Record<string, string> = { storefront: 'Storefront', import: 'Imported' }

/** sourceLabel('agent:claude') -> 'Agent: claude' */
export function sourceLabel(source: string): string {
  if (source.startsWith('agent:')) return `Agent: ${source.slice('agent:'.length)}`
  return SOURCE_LABELS[source] ?? source
}

/** windowLabel({ from: '2026-10-04', to: '2026-11-02' }) -> '4 Oct 2026 to 2 Nov 2026' */
export function windowLabel(window: Pick<ReportSectionWindow, 'from' | 'to'>): string {
  return `${formatStoreDay(window.from)} to ${formatStoreDay(window.to)}`
}

const PERCENT = new Intl.NumberFormat('en-GB', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/** formatRate(0.0333) -> '3.3%' */
export function formatRate(rate: number): string {
  return PERCENT.format(rate)
}

/** Days of stock left, rounded down so the time left is never overstated. */
export function runwayDays(item: { daysLeft: number; reason?: string | undefined }): string {
  if (item.reason !== undefined) return 'Out of stock'
  if (item.daysLeft < 1) return 'less than a day'
  const days = Math.floor(item.daysLeft)
  return days === 1 ? '1 day' : `${days} days`
}
