import type { CONTENT_ROLE_FIELDS } from '@nymbalhq/config'
import type { ProductSnapshot } from '@nymbalhq/types'
import { holdsWhole, sourceParts, type ContentSource } from './claims.js'

export type ContentRoleField = (typeof CONTENT_ROLE_FIELDS)[number]

export const SEO_TITLE_MAX = 60
export const SEO_DESCRIPTION_MIN = 70
export const SEO_DESCRIPTION_MAX = 155

/** Stock marketing phrases no SEO copy of the role's may hold. */
export const FILLER_PHRASES: readonly string[] = [
  'look no further',
  'elevate your',
  'unleash',
  'game-changer',
  'game changer',
  'must-have',
  'best-in-class',
  'second to none',
  'take it to the next level',
]

export interface SeoFinding {
  field: ContentRoleField
  rule:
    | 'empty'
    | 'too_long'
    | 'too_short'
    | 'missing_name'
    | 'repeated_word'
    | 'all_caps'
    | 'emoji'
    | 'markup'
    | 'filler'
  detail?: string
}

/** Length in Unicode code points, so an accented or astral character counts once. */
const length = (s: string) => [...s].length

/** A title holds the name, any case; a name too long for a title is held by its first three words, in order. */
function holdsName(title: string, name: string): boolean {
  const lower = title.toLowerCase()
  const trimmed = name.trim()
  if (length(trimmed) <= SEO_TITLE_MAX) return lower.includes(trimmed.toLowerCase())
  let from = 0
  for (const word of trimmed.toLowerCase().split(/\s+/).slice(0, 3)) {
    const at = lower.indexOf(word, from)
    if (at < 0) return false
    from = at + word.length
  }
  return true
}

const WORD = /\p{L}+/gu

/** The rules every field shares: no word of four or more letters three times, no shouting, emoji, markup or filler. */
function styleFindings(field: ContentRoleField, text: string, capsHeld: ReadonlySet<string>) {
  const findings: SeoFinding[] = []
  const counts = new Map<string, number>()
  for (const [word] of text.matchAll(WORD)) {
    if (length(word) < 4) continue
    const lower = word.toLowerCase()
    counts.set(lower, (counts.get(lower) ?? 0) + 1)
  }
  const repeated = [...counts].filter(([, n]) => n > 2).map(([word]) => word)
  if (repeated.length > 0)
    findings.push({ field, rule: 'repeated_word', detail: repeated.join(', ') })

  const shouted = [...text.matchAll(WORD)]
    .map(([word]) => word)
    .filter((w) => length(w) >= 4 && w === w.toUpperCase() && w !== w.toLowerCase())
    .filter((w) => !capsHeld.has(w))
  if (shouted.length > 0) findings.push({ field, rule: 'all_caps', detail: shouted.join(', ') })

  if (/\p{Extended_Pictographic}/u.test(text)) findings.push({ field, rule: 'emoji' })
  if (/[<>\r\n]/.test(text)) findings.push({ field, rule: 'markup' })

  const lower = text.toLowerCase()
  const filler = FILLER_PHRASES.filter((phrase) => holdsWhole(lower, phrase))
  if (filler.length > 0) findings.push({ field, rule: 'filler', detail: filler.join(', ') })
  return findings
}

/** The all-caps words of four or more letters the product's own text holds in caps (an acronym such as RFID). */
function capsWordsOf(source: ContentSource): Set<string> {
  const held = new Set<string>()
  for (const part of sourceParts(source)) {
    for (const [word] of part.matchAll(WORD)) {
      if (word === word.toUpperCase() && word !== word.toLowerCase()) held.add(word)
    }
  }
  return held
}

/** What breaks the copy rules in `copy`, field by field; `[]` passes. A field left out is not checked. */
export function checkSeoCopy(
  source: ContentSource,
  copy: { seoTitle?: string; seoDescription?: string },
): SeoFinding[] {
  const capsHeld = capsWordsOf(source)
  const findings: SeoFinding[] = []
  if (copy.seoTitle !== undefined) {
    const title = copy.seoTitle.trim()
    if (title === '') {
      findings.push({ field: 'seoTitle', rule: 'empty' })
    } else {
      if (length(title) > SEO_TITLE_MAX)
        findings.push({ field: 'seoTitle', rule: 'too_long', detail: String(length(title)) })
      if (!holdsName(title, source.name)) findings.push({ field: 'seoTitle', rule: 'missing_name' })
      findings.push(...styleFindings('seoTitle', title, capsHeld))
    }
  }
  if (copy.seoDescription !== undefined) {
    const description = copy.seoDescription.trim()
    const n = length(description)
    if (description === '') {
      findings.push({ field: 'seoDescription', rule: 'empty' })
    } else {
      if (n < SEO_DESCRIPTION_MIN)
        findings.push({ field: 'seoDescription', rule: 'too_short', detail: String(n) })
      if (n > SEO_DESCRIPTION_MAX)
        findings.push({ field: 'seoDescription', rule: 'too_long', detail: String(n) })
      findings.push(...styleFindings('seoDescription', description, capsHeld))
    }
  }
  return findings
}

/**
 * Whether the product's current copy needs the role: one of the declared `fields` is blank, past its length bound,
 * or (a title) missing the name, or (a description) under its minimum. An undeclared field is never read, so a
 * product the role could not fix is never a candidate.
 */
export function needsReview(
  product: ProductSnapshot,
  fields: readonly ContentRoleField[],
): boolean {
  return fields.some((field) => {
    const value = product[field].trim()
    if (value === '') return true
    if (field === 'seoTitle')
      return length(value) > SEO_TITLE_MAX || !holdsName(value, product.name)
    const n = length(value)
    return n < SEO_DESCRIPTION_MIN || n > SEO_DESCRIPTION_MAX
  })
}
