import { CUSTOMER_FIELDS, type CustomerField } from '@nymbalhq/config'
import type { ToolResult } from '@nymbalhq/types'
import { freeTextSpans, kindOfKey, replaceIn, wholeSpans, type Piece } from '../customer-fields.js'

/**
 * A tool result as an admin's MCP client receives it: every customer value of a listed kind removed, by the key it sits
 * under (the assistant mask's rule) or, in a history change, by the field its `path` names; each removed value
 * repeated in other text, and each email or phone typed into text, replaced by `[<kind> withheld]`. The kinds taken
 * are named in `withheld`, so an agent can tell a withheld value from a missing one.
 */
export function withholdResult(result: ToolResult, fields: readonly CustomerField[]): ToolResult {
  const structured = result.structuredContent
  if (fields.length === 0 || structured === undefined) return result
  const listed = new Set(fields)
  const listedKind = (key: string | undefined): CustomerField | undefined => {
    const kind = key === undefined ? undefined : kindOfKey(key)
    return kind !== undefined && listed.has(kind) ? kind : undefined
  }
  /** A history change's field, when it is of a listed kind. */
  const changeKind = (value: Record<string, unknown>): CustomerField | undefined => {
    const path = value['path']
    if (typeof path !== 'string' || !('from' in value || 'to' in value)) return undefined
    return listedKind(path.split('.').at(-1))
  }
  /** A change's `from` or `to` that holds a value: null and '' remove nothing. */
  const holds = (value: unknown): boolean => value !== undefined && value !== null && value !== ''

  // Every value removed, first kind met kept, so each repeat of it in text is replaced as the mask's second pass does.
  // Values of three or more characters are also filed by their first three, in the order met, so a string is searched
  // only for the values it holds: a pass per value over every string grows with the square of the result.
  const known = new Map<string, CustomerField>()
  const met = new Map<string, number>()
  const byHead = new Map<string, string[]>()
  const remember = (value: unknown, kind: CustomerField) => {
    if (typeof value !== 'string' || known.has(value)) return
    known.set(value, kind)
    if (value.length < 3) return
    met.set(value, met.size)
    const head = value.slice(0, 3)
    const filed = byHead.get(head)
    if (filed === undefined) byHead.set(head, [value])
    else filed.push(value)
  }
  const collect = (value: unknown, key: string | undefined): void => {
    if (typeof value === 'string') {
      const kind = listedKind(key)
      if (kind !== undefined && value !== '') remember(value, kind)
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, key)
    } else if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      const kind = changeKind(record)
      for (const [k, v] of Object.entries(record)) {
        if (kind !== undefined && (k === 'from' || k === 'to')) {
          if (holds(v)) remember(v, kind)
        } else collect(v, k)
      }
    }
  }
  collect(structured, undefined)

  const taken = new Set<CustomerField>()
  /** The known values `text` holds, longest first and, among equals, in the order met. */
  const repeatsIn = (text: string): string[] => {
    const held = new Set<string>()
    for (let at = 0; at + 3 <= text.length; at++) {
      for (const value of byHead.get(text.slice(at, at + 3)) ?? []) {
        if (text.startsWith(value, at)) held.add(value)
      }
    }
    return [...held].sort((a, b) => b.length - a.length || met.get(a)! - met.get(b)!)
  }
  const replaced = (kind: CustomerField) => (match: string) => {
    taken.add(kind)
    remember(match, kind)
    return `[${kind} withheld]`
  }

  const prose = (text: string): string => {
    let pieces: Piece[] = [{ free: text }]
    for (const value of repeatsIn(text)) {
      pieces = replaceIn(pieces, (free) => wholeSpans(free, value), replaced(known.get(value)!))
    }
    for (const kind of ['email', 'phone'] as const) {
      if (listed.has(kind)) {
        pieces = replaceIn(pieces, (free) => freeTextSpans(free, kind, text), replaced(kind))
      }
    }
    return pieces.map((piece) => ('free' in piece ? piece.free : piece.token)).join('')
  }

  const GONE = Symbol('withheld')
  const strip = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === 'string') {
      const kind = listedKind(key)
      if (kind !== undefined && value !== '') {
        taken.add(kind)
        return GONE
      }
      return prose(value)
    }
    if (Array.isArray(value)) {
      return value.map((item) => strip(item, key)).filter((item) => item !== GONE)
    }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      const kind = changeKind(record)
      const out: Array<[string, unknown]> = []
      for (const [k, v] of Object.entries(record)) {
        if (kind !== undefined && (k === 'from' || k === 'to') && holds(v)) {
          taken.add(kind)
          continue
        }
        const left = strip(v, k)
        if (left !== GONE) out.push([k, left])
      }
      return Object.fromEntries(out)
    }
    return value
  }

  const left = strip(structured, undefined) as Record<string, unknown>
  if (taken.size === 0) return result
  const withheld = { ...left, withheld: CUSTOMER_FIELDS.filter((field) => taken.has(field)) }
  return {
    content: [{ type: 'text', text: JSON.stringify(withheld) }],
    structuredContent: withheld,
    ...(result.isError !== undefined && { isError: result.isError }),
  }
}
