// @vitest-environment jsdom
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { signedInTarget } from '../src/scripts/signed-in-redirect'

// After sign-in the shopper goes on to `?redirect` only when it is a path of the store's own origin: one leading `/`
// (not `//`, not `/\`), no control character, and resolving against the origin to the origin; that path, query and
// hash as the URL parser reads them. Anything else, or none, goes to /account. `signedInTarget` takes the decoded
// value (the listener reads it with URLSearchParams) and the page's origin.

const ORIGIN = 'https://shop.test'
const ACCOUNT = '/account'

/** Each hostile `?redirect=` as it appears in a link, decoded as the page reads it. */
const HOSTILE_IN_LINK = [
  'https://evil.example/x',
  '//evil.example',
  '/\\evil.example',
  '\\/evil.example',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,%3Cscript%3Ealert(1)%3C%2Fscript%3E',
  '/%0d%0a//evil.example',
  '/%09/evil.example',
  'https://shop.test.evil.example/',
  '',
]

/**
 * Decoded values the parser resolves to a path starting `//`, which as a link target is another host: a dot
 * segment (written or percent-encoded) followed by an empty segment.
 */
const DOT_THEN_EMPTY_SEGMENT = [
  '/.//evil.example',
  '/..//evil.example',
  '/%2e//evil.example',
  '/./\\evil.example',
  '/a/..//evil.example/x',
]

const decoded = (inLink: string): string | null =>
  new URLSearchParams(`redirect=${inLink}`).get('redirect')

const SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_~'.split('')
const word = fc.string({ unit: fc.constantFrom(...SAFE), minLength: 1, maxLength: 8 })
/** A path segment the URL parser leaves as written: safe characters and an encoded `/`, never only dots. */
const segment = fc
  .array(fc.oneof(word, fc.constant('%2F'), fc.constant('.')), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join(''))
  .filter((s) => !/^\.+$/.test(s))
const query = fc
  .array(fc.tuple(word, word), { maxLength: 3 })
  .map((pairs) => (pairs.length === 0 ? '' : `?${pairs.map(([k, v]) => `${k}=${v}`).join('&')}`))
const hash = fc.option(word, { nil: undefined }).map((h) => (h === undefined ? '' : `#${h}`))
const samePath = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 5 }), query, hash)
  .map(([segments, q, h]) => `/${segments.join('/')}${q}${h}`)

/** A path ending in a dot segment and a separator, then another separator and a host: `/./`, `/a/%2E\\`, `/..\\`. */
const dotThenHost = fc
  .tuple(
    fc.array(segment, { maxLength: 2 }),
    fc.constantFrom('.', '..', '%2e', '%2E', '%2e%2e', '.%2E'),
    fc.constantFrom('/', '\\'),
    fc.constantFrom('/', '\\'),
    fc.domain(),
    samePath,
  )
  .map(
    ([lead, dot, sep, sep2, host, path]) =>
      `${lead.map((s) => `/${s}`).join('')}/${dot}${sep}${sep2}${host}${path}`,
  )

/** A same-origin path the parser normalises: dot segments and spaces among the segments. */
const normalisedPath = fc
  .tuple(
    fc.array(
      fc.oneof(
        segment,
        fc.constant('..'),
        fc.constant('.'),
        word.map((w) => `${w} ${w}`),
      ),
      {
        minLength: 1,
        maxLength: 6,
      },
    ),
    query,
    hash,
  )
  .map(([segments, q, h]) => `/${segments.join('/')}${q}${h}`)

describe('signedInTarget (Astro)', () => {
  it('AC-11: each hostile redirect from a link (another origin, protocol-relative, backslash, javascript:, data:, CR/LF or tab, a look-alike host, empty) and none go to /account', () => {
    const targets = [...HOSTILE_IN_LINK.map(decoded), null].map((value) => [
      value,
      signedInTarget(value, ORIGIN),
    ])
    expect(targets.filter(([, target]) => target !== ACCOUNT)).toEqual([])
  })

  it('AC-11: property: any host behind an absolute, protocol-relative or backslashed redirect goes to /account', () => {
    fc.assert(
      fc.property(fc.domain(), samePath, (host, path) => {
        for (const value of [
          `https://${host}${path}`,
          `//${host}${path}`,
          `/\\${host}${path}`,
          `\\\\${host}${path}`,
        ]) {
          expect(signedInTarget(value, ORIGIN), value).toBe(ACCOUNT)
        }
      }),
    )
  })

  it('AC-11: property: a same-origin path, query and hash (encoded slashes included) is followed as written', () => {
    fc.assert(
      fc.property(samePath, (path) => {
        expect(signedInTarget(path, ORIGIN)).toBe(path)
      }),
    )
  })

  it('AC-11: property: a same-origin path with dot segments or spaces goes to its pathname, search and hash as the URL parser reads them against the origin', () => {
    fc.assert(
      fc.property(normalisedPath, (path) => {
        const parsed = new URL(path, ORIGIN)
        expect(signedInTarget(path, ORIGIN)).toBe(parsed.pathname + parsed.search + parsed.hash)
      }),
    )
  })
  it('AC-11: a dot segment then an empty segment, which resolves to a protocol-relative path, goes to /account', () => {
    const targets = DOT_THEN_EMPTY_SEGMENT.map((value) => [value, signedInTarget(value, ORIGIN)])
    expect(targets.filter(([, target]) => target !== ACCOUNT)).toEqual([])
    expect(signedInTarget(decoded('%2F.%2F%2Fevil.example'), ORIGIN)).toBe(ACCOUNT)
  })

  it('AC-11: property: whatever the redirect, the target resolves against the origin to the origin', () => {
    const sameOrigin = (value: string) => {
      const target = signedInTarget(value, ORIGIN)
      expect(new URL(target, ORIGIN).origin, `${JSON.stringify(value)} -> ${target}`).toBe(ORIGIN)
      expect(target.startsWith('//') || target.startsWith('/\\'), target).toBe(false)
    }
    fc.assert(fc.property(fc.string(), sameOrigin))
    fc.assert(
      fc.property(
        fc.string().map((s) => `/${s}`),
        sameOrigin,
      ),
    )
    fc.assert(fc.property(dotThenHost, sameOrigin))
  })
})
