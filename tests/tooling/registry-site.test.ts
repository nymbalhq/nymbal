// Reads: nothing
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { badgePath, renderBadge, renderStatusPage } from '../../scripts/registry/site'
import type { EntryHistory, EntryStatus } from '../../scripts/registry/status'

// The status page and its badges are built from a manifest anyone may send a pull request to and from the error
// lines of adapters nobody here wrote, so every such string is data on the page, never markup.

type Entry = Record<string, unknown> & { package: string }

const STATUSES: EntryStatus[] = ['passing', 'failing', 'suspended', 'no-suite', 'first-party']
const GENERATED = new Date('2026-10-31T04:00:00.000Z')

const ENTRIES: Entry[] = [
  {
    package: '@nymbalhq/document-store-redis',
    slot: 'document-store',
    provider: 'redis',
    tier: 'first-party',
    source: { dir: 'packages/adapters/document-store/redis' },
  },
  {
    package: '@acme/nymbal-search',
    slot: 'search',
    provider: 'acme',
    tier: 'community',
    maintainer: 'https://github.com/acme',
    repository: 'https://github.com/acme/nymbal-search',
    source: { npm: '^1.0.0' },
  },
  {
    package: '@zeta/nymbal-mail',
    slot: 'email',
    provider: 'zeta',
    tier: 'verified',
    maintainer: 'https://github.com/zeta',
    source: { npm: '^2.0.0' },
  },
  {
    package: '@omega/nymbal-ai',
    slot: 'ai',
    provider: 'omega',
    tier: 'community',
    maintainer: 'https://github.com/omega',
    source: { npm: '^1.0.0' },
  },
  {
    package: '@kappa/nymbal-ship',
    slot: 'shipping',
    provider: 'kappa',
    tier: 'community',
    maintainer: 'https://github.com/kappa',
    source: { npm: '^1.0.0' },
  },
]

const HISTORY: Record<string, EntryHistory> = {
  '@nymbalhq/document-store-redis': {
    status: 'first-party',
    failingSince: null,
    lastRun: '2026-10-31T03:01:00.000Z',
    line: '',
  },
  '@acme/nymbal-search': {
    status: 'passing',
    failingSince: null,
    lastRun: '2026-10-31T03:02:00.000Z',
    line: 'certified @acme/nymbal-search (search): 30 cases passed',
  },
  '@zeta/nymbal-mail': {
    status: 'failing',
    failingSince: '2026-10-29T03:03:00.000Z',
    lastRun: '2026-10-31T03:03:00.000Z',
    line: 'not certified @zeta/nymbal-mail (email): 3 of 20 cases failed',
  },
  '@omega/nymbal-ai': {
    status: 'no-suite',
    failingSince: null,
    lastRun: '2026-10-31T03:04:00.000Z',
    line: "no contract suite for kind 'ai'",
  },
  '@kappa/nymbal-ship': {
    status: 'suspended',
    failingSince: '2026-10-20T03:05:00.000Z',
    lastRun: '2026-10-31T03:05:00.000Z',
    line: 'not certified @kappa/nymbal-ship (shipping): 1 of 12 cases failed',
  },
}

/** HTML or XML character references decoded, once. */
function decode(text: string): string {
  const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (raw, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X'))
      return String.fromCodePoint(parseInt(ref.slice(2), 16))
    if (ref.startsWith('#')) return String.fromCodePoint(Number(ref.slice(1)))
    return named[ref.toLowerCase()] ?? raw
  })
}

const attrs = (html: string, tag: string, attr: string): string[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*?\\s${attr}\\s*=\\s*("[^"]*"|'[^']*')`, 'gi'))].map(
    (m) => decode(m[1]!.slice(1, -1)),
  )

const textOf = (html: string): string => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ')

/** The pieces of `out` between the two marks, as written (not decoded). */
function between(out: string, open: string, close: string): string[] {
  const found: string[] = []
  let from = 0
  for (;;) {
    const a = out.indexOf(open, from)
    if (a === -1) return found
    const b = out.indexOf(close, a + open.length)
    if (b === -1) return found
    found.push(out.slice(a + open.length, b))
    from = b + close.length
  }
}

/** No raw <, > or " from the input, and every & opens a character reference. */
const escaped = (piece: string): boolean =>
  !/[<>"]/.test(piece) && !/&(?!(#x[0-9a-f]+|#\d+|[a-z]+);)/i.test(piece)

// Marks no HTML or XML escape touches and the badge slug rule turns to hyphens, so a mark is found only where a
// value was written as text or an attribute.
const mark = (tag: string) => ({ open: `[[${tag}:`, close: `:${tag}]]` })
const wrap = (tag: string, s: string) => `${mark(tag).open}${s}${mark(tag).close}`

const hostile = fc.oneof(
  fc.string(),
  fc.string({
    unit: fc.constantFrom('<', '>', '&', '"', "'", 'a', ';', '#', 'x', '/', '=', ' ', 'lt'),
  }),
  fc.constantFrom(
    '"><script>alert(1)</script>',
    '&lt;b&gt;',
    '&amp;',
    '<img src=x onerror=alert(1)>',
  ),
)
const clean = (s: string) => !s.includes('[[') && !s.includes(']]')

describe('AC-4: the status page and badges', () => {
  it('AC-4: the page lists every entry once, with its package, kebab slot, provider, tier, status word, last run and badge, and links the registry readme', () => {
    const html = renderStatusPage({ adapters: ENTRIES }, HISTORY, GENERATED)
    const text = textOf(html)
    const badges = attrs(html, 'img', 'src').filter((src) => /(^|\/)badges\//.test(src))
    const hrefs = attrs(html, 'a', 'href')

    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]!)
    // The status word each row must show, and none of the others: two rows swapping statuses fails.
    const words: Record<string, string> = {
      '@nymbalhq/document-store-redis': 'first-party',
      '@acme/nymbal-search': 'passing',
      '@zeta/nymbal-mail': 'failing',
      '@omega/nymbal-ai': 'no suite',
      '@kappa/nymbal-ship': 'suspended',
    }
    const others = ['passing', 'failing', 'no suite', 'suspended']

    expect(badges.slice().sort()).toEqual(ENTRIES.map((e) => badgePath(e.package)).sort())
    for (const e of ENTRIES) {
      const h = HISTORY[e.package]!
      const own = rows.filter((r) => textOf(r).includes(e.package))
      expect(own, e.package).toHaveLength(1)
      const rowText = textOf(own[0]!).toLowerCase()
      expect(text, e.package).toContain(e.package)
      expect(rowText, e.package).toContain(String(e['slot']))
      expect(rowText, e.package).toContain(String(e['provider']))
      expect(rowText, e.package).toContain(String(e['tier']))
      expect(rowText, e.package).toMatch(new RegExp(words[e.package]!.replace(/[- ]/, '[- ]')))
      for (const word of others.filter((w) => w !== words[e.package])) {
        expect(rowText, `${e.package} shows ${word}`).not.toContain(word)
      }
      expect(own[0], e.package).toContain(h.lastRun)
    }
    expect(html).not.toContain('documentStore')
    expect(
      hrefs.some((h) => /(^|\/)registry\/README\.md$/.test(h)),
      hrefs.join('\n'),
    ).toBe(true)
  })

  it('AC-4: each status has its own badge colour', () => {
    const colours = (svg: string): string =>
      [
        ...svg.matchAll(
          /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|(?:fill|stop-color)\s*[=:]\s*"?([a-z]+)"?/gi,
        ),
      ]
        .map((m) => (m[1] ?? m[0]).toLowerCase())
        .sort()
        .join(',')

    const byStatus = STATUSES.map((s) => colours(renderBadge('@acme/nymbal-search', s)))

    expect(new Set(byStatus).size).toBe(STATUSES.length)
  })

  it('AC-4: every manifest string and run line is HTML-escaped on the page and round-trips (property)', () => {
    fc.assert(
      fc.property(
        fc.record({
          pkg: hostile.filter(clean),
          provider: hostile.filter(clean),
          maintainer: hostile.filter(clean),
          repository: hostile.filter(clean),
          line: hostile.filter(clean),
          status: fc.constantFrom(...STATUSES),
        }),
        (v) => {
          const pkg = wrap('P', v.pkg)
          const entry: Entry = {
            package: pkg,
            slot: 'search',
            provider: wrap('V', v.provider),
            tier: 'community',
            maintainer: `https://github.com/${wrap('M', v.maintainer)}`,
            repository: `https://github.com/${wrap('R', v.repository)}`,
            source: { npm: '^1.0.0' },
          }
          const history = {
            [pkg]: {
              status: v.status,
              failingSince: null,
              lastRun: '2026-10-31T03:00:00.000Z',
              line: wrap('L', v.line),
            },
          }
          const html = renderStatusPage({ adapters: [entry] }, history, GENERATED)

          for (const [tag, value, required] of [
            ['P', v.pkg, true],
            ['V', v.provider, true],
            ['M', v.maintainer, false],
            ['R', v.repository, false],
            ['L', v.line, false],
          ] as const) {
            const pieces = between(html, mark(tag).open, mark(tag).close)
            expect(pieces.length, `${tag} missing from the page`).toBeGreaterThanOrEqual(
              required ? 1 : 0,
            )
            for (const piece of pieces) {
              expect(escaped(piece), `${tag}: ${piece}`).toBe(true)
              expect(decode(piece)).toBe(value)
            }
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-4: every badge label is XML-escaped in the SVG and round-trips (property)', () => {
    fc.assert(
      fc.property(hostile.filter(clean), fc.constantFrom(...STATUSES), (label, status) => {
        const svg = renderBadge(wrap('B', label), status)
        const pieces = between(svg, mark('B').open, mark('B').close)

        expect(pieces.length).toBeGreaterThanOrEqual(1)
        for (const piece of pieces) {
          expect(escaped(piece), piece).toBe(true)
          expect(decode(piece)).toBe(label)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('AC-4: every href the page builds from the manifest starts with https://, whatever scheme the manifest gives', () => {
    const schemes = [
      'javascript:alert(1)//',
      ' javascript:alert(1)',
      'data:text/html,x',
      'http://acme.example',
      'https://acme.example',
    ]
    const entries: Entry[] = schemes.map((scheme, i) => ({
      package: `@acme/nymbal-search-${i}`,
      slot: 'search',
      provider: `acme-${i}`,
      tier: 'community',
      maintainer: `${scheme}/m${i}`,
      repository: `${scheme}/r${i}`,
      source: { npm: '^1.0.0' },
    }))
    const history = Object.fromEntries(
      entries.map((e) => [
        e.package,
        {
          status: 'failing' as const,
          failingSince: '2026-10-30T03:00:00.000Z',
          lastRun: '2026-10-31T03:00:00.000Z',
          line: 'x',
        },
      ]),
    )

    const hrefs = attrs(renderStatusPage({ adapters: entries }, history, GENERATED), 'a', 'href')
    const fromManifest = hrefs.filter((h) => /\/[mr]\d$/.test(h))

    expect(fromManifest.filter((h) => !h.startsWith('https://'))).toEqual([])
    expect(fromManifest).toEqual(
      expect.arrayContaining(['https://acme.example/m4', 'https://acme.example/r4']),
    )
    expect(hrefs.filter((h) => /^\s*(javascript|data|http):/i.test(h))).toEqual([])
  })

  it('AC-4: badgePath is badges/<slug>.svg with the package slug rule', () => {
    expect(
      ['@acme/nymbal-search', '@nymbalhq/document-store-redis', 'plain', 'Acme__Pkg.v2'].map(
        badgePath,
      ),
    ).toEqual([
      'badges/acme-nymbal-search.svg',
      'badges/nymbalhq-document-store-redis.svg',
      'badges/plain.svg',
      'badges/Acme-Pkg-v2.svg',
    ])
  })
})
