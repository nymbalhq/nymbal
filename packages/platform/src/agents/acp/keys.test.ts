import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { acpKeyMatcher } from './keys.js'

// AC-4: the bearer check. A bearer is served only when it equals one configured key, and the answer names that key;
// anything near a key (a prefix, one more character, one character off, another case) is no key at all.

const PRINTABLE = fc
  .array(fc.integer({ min: 0x21, max: 0x7e }), { minLength: 32, maxLength: 64 })
  .map((codes) => String.fromCharCode(...codes))
const NAME = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,39}$/)

/** One to five keys, no name or key twice, as the config's schema lets through. */
const keyList = fc
  .uniqueArray(fc.record({ name: NAME, key: PRINTABLE }), {
    selector: (k) => k.name,
    minLength: 1,
    maxLength: 5,
  })
  .filter((keys) => new Set(keys.map((k) => k.key)).size === keys.length)

const sha256 = (text: string, encoding: 'hex' | 'base64') =>
  createHash('sha256').update(text).digest(encoding)

/** A character other than `c`, still printable. */
const other = (c: string, shift: number) =>
  String.fromCharCode(0x21 + ((c.charCodeAt(0) - 0x21 + 1 + (shift % 93)) % 94))

describe('AC-4: acpKeyMatcher names the key a bearer equals, and nothing else', () => {
  // Kills: only the first key checked; a match answered with the wrong name; the key itself handed back.
  it('AC-4: property: for every configured key, its exact value is answered with its name, and the answer holds no key', () => {
    fc.assert(
      fc.property(keyList, (keys) => {
        const match = acpKeyMatcher(keys)

        const answers = keys.map((k) => match(k.key))

        expect(answers.map((a) => a?.name)).toEqual(keys.map((k) => k.name))
        for (const answer of answers) {
          for (const k of keys) expect(JSON.stringify(answer)).not.toContain(k.key)
        }
      }),
      { numRuns: 300 },
    )
  })

  // Kills: a prefix or startsWith compare; a case-insensitive compare; a nearest-key answer; a name or a digest taken
  // as a key; an empty bearer matched against an empty digest.
  it('AC-4: property: null for an empty bearer and for every near miss of any key: a prefix, the key plus a character, the key with one character changed, its upper or lower case when that differs, a key name, and another key’s SHA-256 digest in hex and base64', () => {
    fc.assert(
      fc.property(keyList, fc.nat(), fc.nat(), fc.nat(), (keys, pick, cut, shift) => {
        const target = keys[pick % keys.length]!
        const at = shift % target.key.length
        const changed =
          target.key.slice(0, at) + other(target.key[at]!, shift) + target.key.slice(at + 1)
        const configured = new Set(keys.map((k) => k.key))
        const misses = [
          '',
          target.key.slice(0, cut % target.key.length),
          target.key.slice(0, -1),
          `${target.key}x`,
          `${target.key} `,
          changed,
          target.key.toUpperCase(),
          target.key.toLowerCase(),
          ...keys.map((k) => k.name),
          ...keys.flatMap((k) => [sha256(k.key, 'hex'), sha256(k.key, 'base64')]),
        ].filter((bearer) => !configured.has(bearer))
        const match = acpKeyMatcher(keys)

        expect(misses.map((bearer) => match(bearer))).toEqual(misses.map(() => null))
      }),
      { numRuns: 300 },
    )
  })
})
