import type { AssistantMaskField } from '@nymbalhq/config'
import {
  changedField,
  freeTextSpans,
  kindOfKey,
  replaceIn,
  wholeSpans,
  type Piece,
} from '../customer-fields.js'

export { FREE_TEXT_EMAIL, FREE_TEXT_PHONE } from '../customer-fields.js'

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

export interface TurnMask {
  result(value: Record<string, unknown>): { value: Record<string, unknown>; masked: number }
  text(text: string, revealed?: readonly RevealedSpan[]): string
  known(text: string): string
  reveal(text: string): string
  revealArgs(args: Record<string, unknown>): Record<string, unknown>
  revealer(): { push(delta: string): Revealed; flush(): Revealed }
  stillHolds(args: Record<string, unknown>): boolean
}

/** Each string with its nearest key; a history change's `from` and `to` take the field its path names. */
function mapStrings(
  value: unknown,
  f: (text: string, key: string | undefined) => string,
  key?: string,
): unknown {
  if (typeof value === 'string') return f(value, key)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, f, key))
  if (typeof value === 'object' && value !== null) {
    const field = changedField(value as Record<string, unknown>)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        mapStrings(v, f, field !== undefined && (k === 'from' || k === 'to') ? field : k),
      ]),
    )
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

  /** The table's values of a listed kind, at least three characters, longest first. */
  const tableValues = () =>
    [...valueOf.entries()]
      .filter(([, v]) => v.value.length >= 3)
      .sort((a, b) => b[1].value.length - a[1].value.length)

  const knownValues = (pieces: Piece[]): Piece[] => {
    let out = pieces
    for (const [token, { value }] of tableValues()) {
      out = replaceIn(out, (free) => wholeSpans(free, value), () => token)
    }
    return out
  }

  const patterns = (pieces: Piece[], whole: string): Piece[] => {
    let out = pieces
    if (listed.has('email')) {
      out = replaceIn(
        out,
        (free) => freeTextSpans(free, 'email'),
        (match) => mint('email', match),
      )
    }
    if (listed.has('phone')) {
      out = replaceIn(
        out,
        (free) => freeTextSpans(free, 'phone', whole),
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
