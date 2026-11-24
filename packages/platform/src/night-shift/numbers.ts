// The no-new-numbers guard over AI guidance: every figure a guidance quotes must be one a value the model read holds.
// Ids, dates and times are taken out of what the model read before its figures are read, so their digits source
// nothing; a date a source holds may still be quoted whole.

const TOKEN = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu
const ASCII_NUMBER = /^[0-9.,]+$/
/** A comma before exactly three digits groups thousands. */
const THOUSANDS = /,(\d{3})(?=$|[.,])/g
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g
/** The line the assistant's loop appends to a non-list result it cut. */
const CUT_LINE = /\n\[cut: \d+ of \d+ characters not shown\]$/
/** The `cut` field the assistant's loop sets on a list result it cut. */
const CUT_FIELD = /^\d+ of \d+ items not shown/
/** What a cut can leave split at the end: part of an id, a date, a time or a number. */
const SPLIT_TAIL = /[\p{L}\p{Nd}\-:.+]+$/u

/** Every number `text` writes, as a value; a token that does not parse, or holds a non-ASCII digit, is NaN. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(TOKEN)].map(([token]) =>
    ASCII_NUMBER.test(token) ? Number(token.replace(THOUSANDS, '$1')) : NaN,
  )
}

function leaves(value: unknown, visit: (leaf: string | number) => void): void {
  if (typeof value === 'string' || typeof value === 'number') visit(value)
  else if (Array.isArray(value)) for (const item of value) leaves(item, visit)
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) leaves(item, visit)
  }
}

/** The numbers a value the model read can source: its number leaves, and its strings' numbers outside ids, dates and times. */
export function sourceNumbers(value: unknown): number[] {
  const found: number[] = []
  leaves(value, (leaf) => {
    if (typeof leaf === 'number') found.push(leaf)
    else {
      const bare = leaf.replace(UUID, ' ').replace(ISO_TIME, ' ').replace(ISO_DATE, ' ')
      found.push(...numbersIn(bare))
    }
  })
  return found.filter((n) => !Number.isNaN(n))
}

/** Every `YYYY-MM-DD` a string leaf of the value holds, a time's own date among them. */
export function sourceDates(value: unknown): string[] {
  const found = new Set<string>()
  leaves(value, (leaf) => {
    if (typeof leaf === 'string') for (const [date] of leaf.matchAll(ISO_DATE)) found.add(date)
  })
  return [...found]
}

/** A cut result without its cut line and without what the cut left split at its end; any other text as it is. */
export function uncut(text: string): string {
  if (!CUT_LINE.test(text)) return text
  return text.replace(CUT_LINE, '').replace(SPLIT_TAIL, '')
}

/**
 * What the model read of one message: its JSON when it parses, without the cut field of a list the loop cut, else the
 * text without what a cut left.
 */
export function asRead(content: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return uncut(content)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const { cut, ...rest } = value as Record<string, unknown>
  return typeof cut === 'string' && CUT_FIELD.test(cut) ? rest : value
}

/**
 * The numbers `guidance` writes that no source holds, after each date a source holds is taken out of it whole. With
 * `minorUnits` above 0 a number also counts as sourced when it is a stored whole amount written in major units.
 */
export function unsourcedNumbers(
  guidance: string,
  sources: readonly number[],
  dates: readonly string[],
  minorUnits: number,
): number[] {
  let rest = guidance
  for (const date of dates) rest = rest.split(date).join(' ')
  const held = new Set(sources)
  const scale = 10 ** minorUnits
  const asMinor = (n: number): boolean => {
    if (minorUnits <= 0) return false
    const minor = n * scale
    const whole = Math.round(minor)
    return Math.abs(minor - whole) < 1e-6 && held.has(whole)
  }
  return numbersIn(rest).filter((n) => Number.isNaN(n) || !(held.has(n) || asMinor(n)))
}
