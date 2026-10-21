import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { s3ObjectUrl } from '../../packages/media-s3/src/index.js'

// Acceptance test for P2-11 AC-3, the pure half (spec P2-11-s3-media, decision 4): s3ObjectUrl(options, key) is the
// base (publicUrl, else endpoint/bucket, else the AWS virtual-hosted URL), with trailing slashes trimmed, then the
// object key `<prefix>/<key>` (just `<key>` when the prefix, once its edge slashes are trimmed, is empty) with each
// path segment percent-encoded. The key is used verbatim: empty and edge segments stay, so two distinct keys never
// share a URL. Kills: keys that collide (`a/b` and `a//b`), a `//` after a trailing-slash base, an encoding that leaves
// a space, `%`, `?` or `#` raw or loses a character, and a prefix that is not where the object is.
// The MinIO half (the URL serves the object) is tests/stores/media-s3-contract.test.ts.

/** What encodeURIComponent leaves unescaped; every other character of a segment must be a %XX escape. */
const ENCODED_SEGMENT = /^(?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-Fa-f]{2})*$/

interface Options {
  bucket: string
  region?: string
  endpoint?: string
  prefix?: string
  publicUrl?: string
}

const trimTrailing = (s: string): string => s.replace(/\/+$/, '')
const trimEdges = (s: string): string => s.replace(/^\/+|\/+$/g, '')

/** Decision 4's base: where every URL starts, followed by `/`. */
function baseOf(o: Options): string {
  if (o.publicUrl !== undefined) return trimTrailing(o.publicUrl)
  if (o.endpoint !== undefined) return `${trimTrailing(o.endpoint)}/${o.bucket}`
  return `https://${o.bucket}.s3.${o.region ?? 'us-east-1'}.amazonaws.com`
}

function objectKeyOf(o: Options, key: string): string {
  const prefix = trimEdges(o.prefix ?? '')
  return prefix === '' ? key : `${prefix}/${key}`
}

const slashes = fc.integer({ min: 0, max: 3 }).map((n) => '/'.repeat(n))

/** A key segment: possibly empty, with spaces, unicode, or characters that mean something in a URL. */
const segment = fc
  .oneof(
    fc.constant(''),
    fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,10}$/),
    fc.constantFrom(
      'with space',
      'a+b',
      '100%',
      'q?x=1',
      'frag#1',
      'a&b=c',
      'tilde~',
      "it's",
      'é',
      '画像',
      '🧪.png',
    ),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 6 }),
  )
  .map((s) => s.replace(/\//g, '_'))
  // `.` and `..` are dot-segments a URL parser resolves away; decision 4 does not cover them.
  .filter((s) => s !== '.' && s !== '..')

const key = fc
  .array(segment, { minLength: 1, maxLength: 5 })
  .map((segs) => segs.join('/'))
  .filter((k) => k !== '')

// No prefix at all is the record's optional key below.
const prefix = fc.oneof(
  fc.constant(''),
  slashes,
  fc
    .tuple(
      slashes,
      fc.array(fc.stringMatching(/^[a-z0-9-]{1,8}$/), { minLength: 1, maxLength: 3 }),
      slashes,
    )
    .map(([lead, segs, tail]) => `${lead}${segs.join('/')}${tail}`),
)

const host = fc.constantFrom(
  'localhost:59000',
  '127.0.0.1:9000',
  'minio.internal',
  'cdn.example.com',
)
const scheme = fc.constantFrom('http', 'https')
const endpoint = fc.tuple(scheme, host, slashes).map(([s, h, t]) => `${s}://${h}${t}`)
const publicUrl = fc
  .tuple(scheme, host, fc.constantFrom('', '/media', '/a/b'), slashes)
  .map(([s, h, path, t]) => `${s}://${h}${path}${t}`)

const options: fc.Arbitrary<Options> = fc
  .record(
    {
      bucket: fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,20}$/),
      region: fc.constantFrom('us-east-1', 'eu-west-2', 'ap-southeast-1'),
      // Each of the three base rules: publicUrl (with or without an endpoint beside it), endpoint alone, neither.
      base: fc.oneof(
        fc.record({ publicUrl, endpoint }, { requiredKeys: ['publicUrl'] }),
        fc.record({ endpoint }),
        fc.constant({}),
      ),
      prefix,
    },
    { requiredKeys: ['bucket', 'base'] },
  )
  .map(({ base, ...rest }): Options => ({ ...rest, ...base }))

/** A second key one small edit away: the near-misses an encoding or normalisation would merge. */
const nearMiss = (k: string) =>
  fc.constantFrom(
    k.replace('/', '//'),
    `${k}/`,
    `/${k}`,
    k.replace(' ', '%20'),
    k.replace(' ', '+'),
    `${k} `,
    k.normalize('NFD'),
    k.toUpperCase(),
  )

describe('P2-11 AC-3: s3ObjectUrl follows decision 4', () => {
  it('AC-3: every URL is the base, then each segment of the object key percent-encoded; decoding the segments gives back the object key', () => {
    fc.assert(
      fc.property(options, key, (o, k) => {
        const url: string = s3ObjectUrl(o, k)
        const base = baseOf(o)

        expect(url.startsWith(`${base}/`), `${url} does not start with ${base}/`).toBe(true)
        const segments = url.slice(base.length + 1).split('/')
        for (const seg of segments) expect(seg, `segment ${seg} of ${url}`).toMatch(ENCODED_SEGMENT)
        expect(segments.map((s) => decodeURIComponent(s)).join('/')).toBe(objectKeyOf(o, k))
      }),
      { numRuns: 400 },
    )
  })

  it('AC-3: two distinct keys never share a URL, near-misses (an added slash, an encoded space, a case change) included', () => {
    const pairs = fc.oneof(
      fc.tuple(key, key),
      key.chain((k) => fc.tuple(fc.constant(k), nearMiss(k))),
    )
    fc.assert(
      fc.property(
        options,
        pairs.filter(([a, b]) => a !== b),
        (o, [a, b]) => {
          expect(s3ObjectUrl(o, a), `${JSON.stringify(a)} and ${JSON.stringify(b)}`).not.toBe(
            s3ObjectUrl(o, b),
          )
        },
      ),
      { numRuns: 400 },
    )
  })
})
