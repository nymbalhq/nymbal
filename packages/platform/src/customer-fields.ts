import type { CustomerField } from '@nymbalhq/config'

/**
 * Where a customer's details sit in a result, read the same way by the assistant's mask and by what an MCP client is
 * withheld: by the key a string sits under, and by the emails and phones typed into free text.
 */

/** The kind a key names; undefined for every other key. */
export function kindOfKey(key: string): CustomerField | undefined {
  if (/email$/i.test(key)) return 'email'
  if (/phone$/i.test(key)) return 'phone'
  if (key === 'addressLine1' || key === 'addressLine2') return 'address'
  if (key === 'postalCode') return 'postcode'
  if (key === 'firstName' || key === 'lastName') return 'name'
  return undefined
}

/** An email in prose: no local-part character just before it, and a last label of two or more letters. */
export const FREE_TEXT_EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g

/**
 * A phone number in prose: from `+`, `(` or `0` and a digit, digits joined by single separators (a parenthesis may
 * sit beside a space, as in `(555) 123-4567`), ending in a digit. Its digits are counted, and its neighbours checked,
 * by `isPhone`.
 */
export const FREE_TEXT_PHONE = /(?:[+(]|0(?=[0-9]))[0-9]+(?:(?:\)[ .-]?|[ .-]?\(|[ .-])[0-9]+)*/g

const WORDISH = /[\p{L}\p{N}]/u
const PHONE_JOINERS = new Set(['-', '.', '(', ')'])

/** Whether `text[at]`, looking past `-`, `.` and parentheses in direction `step`, is a letter or digit. */
function wordishBeside(text: string, at: number, step: 1 | -1): boolean {
  let i = at
  while (i >= 0 && i < text.length && PHONE_JOINERS.has(text[i]!)) i += step
  return i >= 0 && i < text.length && WORDISH.test(text[i]!)
}

function isPhone(text: string, start: number, match: string): boolean {
  const digits = match.replace(/[^0-9]/g, '').length
  if (digits < 10 || digits > 15) return false
  // A UUID's all-digit groups sit between hex groups: looking past the hyphens keeps them out.
  return !wordishBeside(text, start - 1, -1) && !wordishBeside(text, start + match.length, 1)
}

/** A place in a text: UTF-16 offsets, `end` exclusive. */
export interface Span {
  start: number
  end: number
}

/**
 * The emails, or the phones, typed into `text`. A phone is looked for only when `whole` (the string `text` is a piece
 * of; `text` itself when absent) holds whitespace, so an id or a reference made of digits is never read as one.
 */
export function freeTextSpans(text: string, kind: 'email' | 'phone', whole?: string): Span[] {
  if (kind === 'email') {
    return [...text.matchAll(FREE_TEXT_EMAIL)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
    }))
  }
  if (!/\s/.test(whole ?? text)) return []
  return [...text.matchAll(FREE_TEXT_PHONE)]
    .filter((m) => isPhone(text, m.index, m[0]))
    .map((m) => ({ start: m.index, end: m.index + m[0].length }))
}

/** Every place `value` stands whole in `text`: no letter or digit just before or after it. */
export function wholeSpans(text: string, value: string): Span[] {
  const found: Span[] = []
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at)) {
    const end = at + value.length
    if (!WORDISH.test(text[at - 1] ?? '') && !WORDISH.test(text[end] ?? '')) {
      found.push({ start: at, end })
      at = end
    } else {
      at += 1
    }
  }
  return found
}

/** A string cut into free text and the tokens placed in it, so no later step rewrites inside a token. */
export type Piece = { free: string } | { token: string }

/** Each free piece's spans `find` gives replaced by the token `toToken` gives for the text it spans. */
export function replaceIn(
  pieces: Piece[],
  find: (free: string) => Span[],
  toToken: (match: string) => string,
): Piece[] {
  return pieces.flatMap((piece) => {
    if (!('free' in piece)) return [piece]
    const out: Piece[] = []
    let last = 0
    for (const { start, end } of find(piece.free)) {
      if (start > last) out.push({ free: piece.free.slice(last, start) })
      out.push({ token: toToken(piece.free.slice(start, end)) })
      last = end
    }
    if (last < piece.free.length) out.push({ free: piece.free.slice(last) })
    return out
  })
}
