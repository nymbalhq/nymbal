// A store's day and hour belong to its zone, never to the server's or to UTC. Formatters are costly to build, so one
// per zone is kept for the life of the process.

const dayFormats = new Map<string, Intl.DateTimeFormat>()
const minuteFormats = new Map<string, Intl.DateTimeFormat>()

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let format = dayFormats.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    dayFormats.set(timeZone, format)
  }
  return format
}

function minuteFormat(timeZone: string): Intl.DateTimeFormat {
  let format = minuteFormats.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone, minute: '2-digit', second: '2-digit' })
    minuteFormats.set(timeZone, format)
  }
  return format
}

/** The store day an instant falls on, `YYYY-MM-DD`. */
export function localDayOf(at: Date, timeZone: string): string {
  return dayFormat(timeZone).format(at)
}

/**
 * The instant the shopper's local hour began. It is the instant less the minutes and seconds past the local hour, not
 * a wall-clock reading parsed back, so the repeated hour of a clock change is two buckets.
 */
export function localHourStartOf(at: Date, timeZone: string): Date {
  const parts = minuteFormat(timeZone).formatToParts(at)
  const part = (type: 'minute' | 'second') => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const past = part('minute') * 60_000 + part('second') * 1_000 + at.getUTCMilliseconds()
  return new Date(at.getTime() - past)
}

/** The day `n` days from a `YYYY-MM-DD` day. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** How many days from `from` to `to`, counting both. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1
}
