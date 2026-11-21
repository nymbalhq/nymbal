import { readFileSync } from 'node:fs'
import fc from 'fast-check'

// The WordPress-made vectors (wordpress-hashes.json, made by wordpress-hashes.php from a WordPress release's own
// code), and what the tests derive from them: wrong passwords one edit away, stored values one field away from a
// shape the store accepts, and the accept rule written out independently of the code under test.

export type VectorFormat = 'phpass' | 'wp-bcrypt' | 'bcrypt'

export interface WordPressVector {
  name: string
  format: VectorFormat
  cost: number | null
  /** What the shopper types. */
  password: string
  /** What WordPress hashed: the password as a form posts it, slashed by `wp_magic_quotes`. */
  posted: string
  bytes: number
  hash: string
  /** False only where the store refuses what WordPress accepts: phpass over 256 bytes. */
  nymbalVerifies: boolean
  /** For a password the slashing changes, the same recipe over the text as typed: WordPress refuses it through a form. */
  unslashedHash?: string
}

interface Fixture {
  made: { wordpress: string; php: string; command: string }
  vectors: WordPressVector[]
}

const fixture = JSON.parse(
  readFileSync(new URL('./wordpress-hashes.json', import.meta.url), 'utf8'),
) as Fixture

export const VECTORS: readonly WordPressVector[] = fixture.vectors

export function vector(name: string): WordPressVector {
  const found = VECTORS.find((v) => v.name === name)
  if (found === undefined) throw new Error(`no WordPress vector named ${name}`)
  return found
}

export const RECIPE = 'wordpress'
export const tagged = (hash: string): string => `legacy:${RECIPE}:${hash}`

/**
 * What WordPress's wp_authenticate trims from the ends of a typed password: PHP's trim() set but NUL, which the
 * slashing of `$_POST` has made the two characters `\0` by then.
 */
export const PHP_TRIM = [' ', '\n', '\r', '\t', '\v'] as const

/** What WordPress keeps at the ends: whitespace PHP's trim() keeps, which String.prototype.trim() would take, and NUL. */
export const NOT_PHP_TRIM = ['\0', '\f', ' ', ' ', '﻿'] as const

const INSERTABLE = ['x', 'Q', '7', '-', 'é', '€', '🦊'] as const

const cased = (c: string): boolean => c.toUpperCase() !== c.toLowerCase()
const flip = (c: string): string => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())

/**
 * A password one inner edit away from `password` (insert, delete, replace, case flip, or a space inside it), never
 * whitespace at either end: what WordPress would refuse, since it trims only the ends. Edits are by code point.
 */
export function innerEdit(password: string): fc.Arbitrary<string> {
  const cps = Array.from(password)
  const join = (parts: string[]) => parts.join('')
  const at = fc.integer({ min: 0, max: cps.length - 1 })
  const letters = cps.map((c, i) => (cased(c) ? i : -1)).filter((i) => i >= 0)
  const edits: fc.Arbitrary<string>[] = [
    fc
      .record({ at: fc.integer({ min: 0, max: cps.length }), ch: fc.constantFrom(...INSERTABLE) })
      .map(({ at: i, ch }) => join([...cps.slice(0, i), ch, ...cps.slice(i)])),
    at.map((i) => join([...cps.slice(0, i), ...cps.slice(i + 1)])),
    fc
      .record({ at, ch: fc.constantFrom(...INSERTABLE) })
      .filter(({ at: i, ch }) => cps[i] !== ch)
      .map(({ at: i, ch }) => join([...cps.slice(0, i), ch, ...cps.slice(i + 1)])),
    fc
      .integer({ min: 1, max: cps.length - 1 })
      .map((i) => join([...cps.slice(0, i), ' ', ...cps.slice(i)])),
  ]
  if (letters.length > 0) {
    edits.push(
      fc
        .constantFrom(...letters)
        .map((i) => join([...cps.slice(0, i), flip(cps[i]!), ...cps.slice(i + 1)])),
    )
  }
  return fc.oneof(...edits).filter((p) => p !== password)
}

/** PHP-trim whitespace on one or both ends of `password`: what WordPress still signs in. */
export function outerWhitespace(password: string): fc.Arbitrary<string> {
  const run = (min: number) =>
    fc.array(fc.constantFrom(...PHP_TRIM), { minLength: min, maxLength: 4 })
  return fc
    .oneof(fc.tuple(run(1), run(0)), fc.tuple(run(0), run(1)), fc.tuple(run(1), run(1)))
    .map(([left, right]) => `${left.join('')}${password}${right.join('')}`)
}

// ─── The accept rule, written out ───────────────────────────────────────────────────────────────────────────────

export const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const PHPASS = /^\$P\$[./0-9A-Za-z]{31}$/
const BCRYPT = /^(?:\$wp)?\$2[aby]\$(\d{2})\$[./0-9A-Za-z]{53}$/

export type MaxCost = 10 | 11 | 12
export const MAX_COSTS: readonly MaxCost[] = [10, 11, 12]

/**
 * What `acceptLegacyHash('wordpress', s, m)` must answer. `either` is a `$P$` whose count character is outside the
 * alphabet: the rule says both "any count character but B is cost" and "a character outside the alphabet is format".
 */
export function expectedAcceptance(
  s: string,
  m: MaxCost,
): { ok: true } | { ok: false; reason: 'format' | 'cost' | 'either' } {
  if (PHPASS.test(s)) return s[3] === 'B' ? { ok: true } : { ok: false, reason: 'cost' }
  if (/^\$P\$.[./0-9A-Za-z]{30}$/.test(s)) return { ok: false, reason: 'either' }
  const bcrypt = BCRYPT.exec(s)
  if (bcrypt !== null) {
    const cost = Number(bcrypt[1])
    return cost >= 10 && cost <= m ? { ok: true } : { ok: false, reason: 'cost' }
  }
  return { ok: false, reason: 'format' }
}

const twoDigits = (n: number): string => String(n).padStart(2, '0')
const B64_CHARS = Array.from(ITOA64)

/** A string of `n` characters from the bcrypt and phpass alphabet. */
export const alphabetString = (n: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...B64_CHARS), { minLength: n, maxLength: n }).map((a) => a.join(''))

/** Every shape AC-2 names, at the border: each `$P$` count character, each bcrypt cost, and the near misses. */
export function borderShapes(): fc.Arbitrary<string> {
  const counts = Array.from({ length: 'z'.charCodeAt(0) - '/'.charCodeAt(0) + 1 }, (_, i) =>
    String.fromCharCode('/'.charCodeAt(0) + i),
  )
  const costs = Array.from({ length: 28 }, (_, i) => twoDigits(i + 4))
  const minors = ['a', 'b', 'y'] as const
  const valid = fc.oneof(
    fc.tuple(alphabetString(8), alphabetString(22)).map(([salt, hash]) => `$P$B${salt}${hash}`),
    fc
      .tuple(
        fc.constantFrom('', '$wp'),
        fc.constantFrom(...minors),
        fc.constantFrom('10', '11', '12'),
        alphabetString(53),
      )
      .map(([wp, minor, cost, rest]) => `${wp}$2${minor}$${cost}$${rest}`),
  )
  return fc.oneof(
    fc
      .tuple(fc.constantFrom(...counts), alphabetString(8), alphabetString(22))
      .map(([count, salt, hash]) => `$P$${count}${salt}${hash}`),
    fc
      .tuple(
        fc.constantFrom('', '$wp'),
        fc.constantFrom(...minors),
        fc.constantFrom(...costs),
        alphabetString(53),
      )
      .map(([wp, minor, cost, rest]) => `${wp}$2${minor}$${cost}$${rest}`),
    fc
      .array(fc.constantFrom(...'0123456789abcdef'), { minLength: 32, maxLength: 32 })
      .map((a) => a.join('')),
    alphabetString(31).map((rest) => `$H$${rest}`),
    alphabetString(43).map((rest) => `$argon2id$v=19$m=65536,t=4,p=1$${rest.slice(0, 22)}$${rest}`),
    // phpass at 33 and 35 characters, bcrypt at 59 and 61.
    alphabetString(30).map((rest) => `$P$B${rest}`),
    alphabetString(32).map((rest) => `$P$B${rest}`),
    alphabetString(52).map((rest) => `$2y$10$${rest}`),
    alphabetString(54).map((rest) => `$2y$10$${rest}`),
    alphabetString(52).map((rest) => `$wp$2y$10$${rest}`),
    alphabetString(54).map((rest) => `$wp$2y$10$${rest}`),
    fc.tuple(valid, fc.constantFrom(' ', '\t', '\n')).map(([s, ws]) => `${ws}${s}`),
    fc.tuple(valid, fc.constantFrom(' ', '\t', '\n')).map(([s, ws]) => `${s}${ws}`),
    valid,
  )
}

// ─── Stored values one field away from an accepted shape ────────────────────────────────────────────────────────

export interface NearValid {
  label: string
  /** The value as the row holds it, tagged. */
  stored: string
  /** The password of the vector it was made from: right for the original, so only the broken field refuses it. */
  password: string
}

const OUTSIDE = ['!', '_', '#', 'é', ' ', '\0'] as const

function replaceAt(s: string, i: number, ch: string): string {
  return s.slice(0, i) + ch + s.slice(i + 1)
}

/** Every near-valid stored value AC-2 names, for a store whose most a bcrypt hash may cost is `m`. */
export function nearValidStored(m: MaxCost): NearValid[] {
  const out: NearValid[] = []
  const phpass = vector('phpass ascii')
  for (const n of [7, 8, 9, 10, 11, 12, ...Array.from({ length: 17 }, (_, i) => i + 14)]) {
    out.push({
      label: `phpass count ${n}`,
      stored: tagged(replaceAt(phpass.hash, 3, ITOA64[n]!)),
      password: phpass.password,
    })
  }
  const bcrypts = [
    vector('wp bcrypt 10 ascii'),
    vector('bcrypt 10 ascii'),
    vector('wp bcrypt 12 ascii'),
  ]
  for (const v of bcrypts) {
    const at = v.hash.indexOf('$', v.hash.startsWith('$wp') ? 4 : 1) + 1
    for (let cost = 4; cost <= 31; cost += 1) {
      if (cost >= 10 && cost <= m) continue
      out.push({
        label: `${v.name} at cost ${cost}`,
        stored: tagged(v.hash.slice(0, at) + twoDigits(cost) + v.hash.slice(at + 2)),
        password: v.password,
      })
    }
  }
  if (m === 10) {
    const twelve = vector('wp bcrypt 12 ascii')
    out.push({
      label: 'the cost-12 vector at maxCost 10',
      stored: tagged(twelve.hash),
      password: twelve.password,
    })
  }
  for (const v of [phpass, ...bcrypts.slice(0, 2)]) {
    const saltAt = v.format === 'phpass' ? 4 : v.hash.length - 53
    const hashAt = v.hash.length - 5
    for (const ch of OUTSIDE) {
      out.push({
        label: `${v.name}, ${JSON.stringify(ch)} in the salt`,
        stored: tagged(replaceAt(v.hash, saltAt + 2, ch)),
        password: v.password,
      })
      out.push({
        label: `${v.name}, ${JSON.stringify(ch)} in the hash`,
        stored: tagged(replaceAt(v.hash, hashAt, ch)),
        password: v.password,
      })
    }
    out.push({
      label: `${v.name}, one character long`,
      stored: tagged(`${v.hash}a`),
      password: v.password,
    })
    out.push({
      label: `${v.name}, one character short`,
      stored: tagged(v.hash.slice(0, -1)),
      password: v.password,
    })
  }
  // 60 characters whose salt bcrypt cannot decode.
  out.push({
    label: 'bcrypt with a broken salt',
    stored: tagged(`$2y$10$${'!'.repeat(22)}${'a'.repeat(31)}`),
    password: 'x',
  })
  out.push({
    label: 'wp bcrypt with a broken salt',
    stored: tagged(`$wp$2y$10$${'*'.repeat(22)}${'a'.repeat(31)}`),
    password: 'x',
  })
  out.push({
    label: 'an md5 of the password',
    stored: tagged('5f4dcc3b5aa765d61d8327deb882cf99'),
    password: 'password',
  })
  return out
}

/** Stored values with no shape at all: any text after `legacy:`, an unknown recipe, garbage, empty. */
export const arbitraryStored: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 80 }).map((s) => `legacy:${s}`),
  fc.string({ unit: 'binary', maxLength: 80 }).map((s) => tagged(s)),
  fc.constantFrom(
    '',
    'legacy:',
    'legacy:wordpress:',
    `legacy:magento:${VECTORS[0]!.hash}`,
    `legacy:wordpress:legacy:wordpress:${VECTORS[0]!.hash}`,
    VECTORS[0]!.hash,
    'IMPORTED_NO_PASSWORD',
  ),
  fc.string({ unit: 'binary', maxLength: 120 }),
)
