import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { serializeJsonLd } from '@/lib/seo'

// A product's name or description reaches the page inside <script type="application/ld+json">, so the serialised
// JSON must hold nothing the HTML parser reads as markup: no `<`, `>` or `&`, and no U+2028 / U+2029. It must still
// parse back to the value it was given.

const MARKUP = /[<>&\u2028\u2029]/

/** Strings built from the pieces that break out of a script element or confuse a parser, and plain text. */
const hostileString = fc
  .array(
    fc.constantFrom(
      '</script>',
      '</SCRIPT >',
      '<script>window.__x=1</script>',
      '<!--',
      '-->',
      '&',
      '&amp;',
      '<',
      '>',
      '\u2028',
      '\u2029',
      '"',
      '\\',
      '/',
      'Tee',
      ' ',
      'é',
    ),
    { maxLength: 12 },
  )
  .map((parts) => parts.join(''))

const text = fc.oneof(hostileString, fc.string())

const { value } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    text,
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(text, tie('value'), { maxKeys: 4 }),
  ),
}))

describe('AC-1: JSON-LD is serialised with no markup characters (Next.js)', () => {
  it('AC-1: for any value, serializeJsonLd holds no <, >, &, U+2028 or U+2029 and parses back to the value JSON.stringify would give', () => {
    fc.assert(
      fc.property(value, (v) => {
        const serialized = serializeJsonLd(v)
        expect(serialized).not.toMatch(MARKUP)
        expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(v)))
      }),
      { numRuns: 300 },
    )
  })
})
