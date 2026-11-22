/**
 * formatDate('2026-04-24T14:32:00Z') -> "24 Apr 2026, 14:32"
 */
export function formatDate(iso: string): string {
  const date = new Date(iso)
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/**
 * formatDateShort('2026-04-24T14:32:00Z') -> "24 Apr"
 */
export function formatDateShort(iso: string): string {
  const date = new Date(iso)
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
  }).format(date)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * formatStoreDay('2026-11-21') -> "21 Nov 2026" in every browser zone: a store day is a calendar day, not an instant,
 * so it is written from its own parts (and with three-letter months, which ICU's en-GB does not keep for September).
 */
export function formatStoreDay(day: string): string {
  const [year, month, date] = day.split('-')
  return `${Number(date)} ${MONTHS[Number(month) - 1]} ${year}`
}

/**
 * formatRelative('2026-04-24T12:00:00Z') -> "2 hours ago", "just now", "yesterday"
 */
export function formatRelative(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHr / 24)

  if (diffSec < 30) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return formatDateShort(iso)
}
