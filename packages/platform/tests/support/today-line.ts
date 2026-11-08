// The assistant prompt's date line, worked out independently of the loop: the calendar day of instant `at` in `zone`
// and its English weekday, read from `Intl.DateTimeFormat` with that time zone.

const formats = new Map<string, Intl.DateTimeFormat>()

function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formats.set(zone, format)
  }
  return format
}

/** `{ weekday, day }` of `at` in `zone`, the day as `yyyy-mm-dd`. */
export function calendarDayOf(at: number, zone: string): { weekday: string; day: string } {
  const parts = formatIn(zone).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value
  return { weekday: part('weekday'), day: `${part('year')}-${part('month')}-${part('day')}` }
}

/** The line that tells the model today's date at `at` in `zone`. */
export function todayLineOf(at: number, zone: string): string {
  const { weekday, day } = calendarDayOf(at, zone)
  return `Today is ${weekday} ${day} in the store's time zone (${zone}); work out dates such as "the last 30 days" from today.`
}
