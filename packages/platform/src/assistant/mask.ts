import type { AssistantMaskField } from '@nymbalhq/config'

/**
 * Reversible masking of a customer's details for one assistant turn: the AI provider reads `[email-1]` where a tool
 * result held an email, and each placeholder is turned back into its value before a tool runs and before the admin
 * sees the answer. The table lives in the turn's memory only.
 */

export type MaskField = AssistantMaskField

export const TOKEN_SOURCE = '\\[(email|phone|address|postcode|name)-([1-9][0-9]*)\\]'
/** Not global, so a caller's `test` keeps no `lastIndex`. */
export const TOKEN = new RegExp(TOKEN_SOURCE)
const TOKENS = () => new RegExp(TOKEN_SOURCE, 'g')

/** A revealed value's place in a text: UTF-16 offsets, `end` exclusive. */
export interface RevealedSpan {
  start: number
  end: number
  kind: MaskField
}

export interface Revealed {
  text: string
  revealed: RevealedSpan[]
}

/** Every placeholder-shaped text rewritten with a space for its hyphen: the same length, and never a token again. */
export function neutralise(text: string): string {
  return text.replace(TOKENS(), '[$1 $2]')
}

/** An email in prose: no local-part character just before it, and a last label of two or more letters. */
export const FREE_TEXT_EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g

/**
 * A phone number in prose: from `+`, `(` or `0` and a digit, digits joined by single separators (a parenthesis may
 * sit beside a space, as in `(555) 123-4567`), ending in a digit. Its digits are counted, and its neighbours checked,
 * by `phoneAt`.
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

const standsWhole = (text: string, start: number, end: number): boolean =>
  !WORDISH.test(text[start - 1] ?? '') && !WORDISH.test(text[end] ?? '')

/** A string cut into free text and the tokens placed in it, so no later step rewrites inside a token. */
type Piece = { free: string } | { token: string }

export interface TurnMask {
  result(value: Record<string, unknown>): { value: Record<string, unknown>; masked: number }
  text(text: string, revealed?: readonly RevealedSpan[]): string
  known(text: string): string
  reveal(text: string): string
  revealArgs(args: Record<string, unknown>): Record<string, unknown>
  revealer(): { push(delta: string): Revealed; flush(): Revealed }
  stillHolds(args: Record<string, unknown>): boolean
}

/** The kind a key masks; undefined for every other key. */
function kindOfKey(key: string): MaskField | undefined {
  if (/email$/i.test(key)) return 'email'
  if (/phone$/i.test(key)) return 'phone'
  if (key === 'addressLine1' || key === 'addressLine2') return 'address'
  if (key === 'postalCode') return 'postcode'
  if (key === 'firstName' || key === 'lastName') return 'name'
  return undefined
}

function mapStrings(
  value: unknown,
  f: (text: string, key: string | undefined) => string,
  key?: string,
): unknown {
  if (typeof value === 'string') return f(value, key)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, f, key))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f, k)]))
  }
  return value
}

function someString(value: unknown, test: (text: string) => boolean): boolean {
  if (typeof value === 'string') return test(value)
  if (Array.isArray(value)) return value.some((item) => someString(item, test))
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => someString(item, test))
  }
  return false
}

/**
 * One turn's mask over `fields`. Only listed kinds are minted, so a kind left out takes no numbers. Under an empty
 * mask nothing is minted and every method gives its input back.
 */
export function createTurnMask(fields: readonly MaskField[]): TurnMask {
  const listed = new Set(fields)
  const tokenOf = new Map<string, string>()
  const valueOf = new Map<string, { value: string; kind: MaskField }>()
  const counts = new Map<MaskField, number>()

  const mint = (kind: MaskField, value: string): string => {
    const key = `${kind}\u0000${value}`
    const known = tokenOf.get(key)
    if (known !== undefined) return known
    const n = (counts.get(kind) ?? 0) + 1
    counts.set(kind, n)
    const token = `[${kind}-${n}]`
    tokenOf.set(key, token)
    valueOf.set(token, { value, kind })
    return token
  }

  /** Each free piece's matches of `find` replaced by the token `toToken` gives for the matched text. */
  const replaceIn = (
    pieces: Piece[],
    find: (free: string) => Array<{ start: number; end: number }>,
    toToken: (match: string) => string,
  ): Piece[] =>
    pieces.flatMap((piece) => {
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

  /** The table's values of a listed kind, at least three characters, longest first. */
  const tableValues = () =>
    [...valueOf.entries()]
      .filter(([, v]) => v.value.length >= 3)
      .sort((a, b) => b[1].value.length - a[1].value.length)

  const knownValues = (pieces: Piece[]): Piece[] => {
    let out = pieces
    for (const [token, { value }] of tableValues()) {
      out = replaceIn(
        out,
        (free) => {
          const found: Array<{ start: number; end: number }> = []
          for (let at = free.indexOf(value); at !== -1; at = free.indexOf(value, at)) {
            if (standsWhole(free, at, at + value.length)) {
              found.push({ start: at, end: at + value.length })
              at += value.length
            } else {
              at += 1
            }
          }
          return found
        },
        () => token,
      )
    }
    return out
  }

  const patterns = (pieces: Piece[], whole: string): Piece[] => {
    let out = pieces
    if (listed.has('email')) {
      out = replaceIn(
        out,
        (free) =>
          [...free.matchAll(FREE_TEXT_EMAIL)].map((m) => ({
            start: m.index,
            end: m.index + m[0].length,
          })),
        (match) => mint('email', match),
      )
    }
    if (listed.has('phone') && /\s/.test(whole)) {
      out = replaceIn(
        out,
        (free) =>
          [...free.matchAll(FREE_TEXT_PHONE)]
            .filter((m) => isPhone(free, m.index, m[0]))
            .map((m) => ({ start: m.index, end: m.index + m[0].length })),
        (match) => mint('phone', match),
      )
    }
    return out
  }

  const joined = (pieces: Piece[]) => ({
    text: pieces.map((p) => ('free' in p ? p.free : p.token)).join(''),
    masked: pieces.filter((p) => 'token' in p).length,
  })

  /** Pass 2 over a string that holds no token yet. */
  const prose = (text: string) => joined(patterns(knownValues([{ free: text }]), text))

  /** Existing token-shaped text kept apart, so `known` never rewrites inside a placeholder. */
  const splitTokens = (text: string): Piece[] => {
    const out: Piece[] = []
    let last = 0
    for (const m of text.matchAll(TOKENS())) {
      if (m.index > last) out.push({ free: text.slice(last, m.index) })
      out.push({ token: m[0] })
      last = m.index + m[0].length
    }
    if (last < text.length) out.push({ free: text.slice(last) })
    return out
  }

  const reveal = (text: string): string =>
    text.replace(TOKENS(), (token) => valueOf.get(token)?.value ?? token)

  const revealSpans = (text: string): Revealed => {
    const revealed: RevealedSpan[] = []
    let out = ''
    let last = 0
    for (const m of text.matchAll(TOKENS())) {
      const found = valueOf.get(m[0])
      if (found === undefined) continue
      out += text.slice(last, m.index)
      revealed.push({ start: out.length, end: out.length + found.value.length, kind: found.kind })
      out += found.value
      last = m.index + m[0].length
    }
    return { text: out + text.slice(last), revealed }
  }

  /** The trailing part of `text` that may still become a minted token: from its last `[`, a proper prefix of one. */
  const heldTail = (text: string): number => {
    const at = text.lastIndexOf('[')
    if (at === -1) return text.length
    const tail = text.slice(at)
    for (const token of valueOf.keys()) {
      if (token.length > tail.length && token.startsWith(tail)) return at
    }
    return text.length
  }

  return {
    result(value) {
      if (listed.size === 0) return { value, masked: 0 }
      const neutral = mapStrings(value, (text) => neutralise(text)) as Record<string, unknown>
      // Every keyed value is minted before any prose is read, so prose met first is masked too.
      mapStrings(neutral, (text, key) => {
        const kind = key === undefined ? undefined : kindOfKey(key)
        if (kind !== undefined && listed.has(kind) && text !== '') mint(kind, text)
        return text
      })
      let masked = 0
      const out = mapStrings(neutral, (text, key) => {
        const kind = key === undefined ? undefined : kindOfKey(key)
        if (kind !== undefined && listed.has(kind) && text !== '') {
          masked += 1
          return mint(kind, text)
        }
        const done = prose(text)
        masked += done.masked
        return done.text
      }) as Record<string, unknown>
      return { value: out, masked }
    },

    text(text, revealed = []) {
      if (listed.size === 0) return text
      const neutral = neutralise(text)
      const pieces: Piece[] = []
      let last = 0
      for (const span of revealed) {
        if (!listed.has(span.kind) || span.start < last || span.end <= span.start) continue
        if (span.start > last) pieces.push({ free: neutral.slice(last, span.start) })
        pieces.push({ token: mint(span.kind, neutral.slice(span.start, span.end)) })
        last = span.end
      }
      if (last < neutral.length) pieces.push({ free: neutral.slice(last) })
      return joined(patterns(knownValues(pieces), neutral)).text
    },

    known(text) {
      if (valueOf.size === 0) return text
      return joined(knownValues(splitTokens(text))).text
    },

    reveal,

    revealArgs(args) {
      return mapStrings(args, reveal) as Record<string, unknown>
    },

    revealer() {
      let held = ''
      return {
        push(delta) {
          const text = held + delta
          const at = heldTail(text)
          held = text.slice(at)
          return revealSpans(text.slice(0, at))
        },
        flush() {
          const text = held
          held = ''
          return revealSpans(text)
        },
      }
    },

    stillHolds(args) {
      return someString(args, (text) => TOKEN.test(text))
    },
  }
}
