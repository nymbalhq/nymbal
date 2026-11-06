import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import {
  lighthousePairs,
  readLighthouseResult,
  summariseSide,
  type LighthouseMetric,
  type LighthousePair,
  type LighthouseSample,
  type LighthouseSection,
  type LighthouseSide,
} from '../../src/preview/lighthouse.js'
import { formatPreviewReport, writePreview } from '../../src/preview/report.js'
import type { PreviewReport, RedirectRow } from '../../src/preview/types.js'

// How a preview turns Lighthouse results into a comparison: what one result says, the median of a side's runs, which
// pages are paired, and the report's Lighthouse section. Every expected value is worked out here from the inputs.
//
// fixtures/lhr-ok.json and fixtures/lhr-404.json are results the root's Lighthouse 12.6.1 wrote for a small HTML page
// and for a page answering 404, with headless Chrome:
//
//   pnpm exec lighthouse <url> --output=json --output-path=<file> --only-categories=performance \
//     --no-enable-error-reporting --quiet --chrome-flags="--headless=new"
//
// trimmed to lighthouseVersion, requestedUrl, finalDisplayedUrl, fetchTime, runtimeError, userAgent,
// environment.{hostUserAgent,benchmarkIndex}, configSettings.{formFactor,throttlingMethod,throttling,screenEmulation,
// emulatedUserAgent,onlyCategories}, categories.performance and the five audits read (id, title, score,
// scoreDisplayMode, numericValue, numericUnit, displayValue, errorMessage).
//
// fixtures/report-without-lighthouse.json holds a fixed report and the Markdown the seven-section report gave for it
// before the Lighthouse section existed.

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown

const METRICS: readonly LighthouseMetric[] = [
  'performance',
  'lcpMs',
  'cls',
  'tbtMs',
  'bytes',
  'serverMs',
]
const AUDIT_OF: Record<Exclude<LighthouseMetric, 'performance'>, string> = {
  lcpMs: 'largest-contentful-paint',
  cls: 'cumulative-layout-shift',
  tbtMs: 'total-blocking-time',
  bytes: 'total-byte-weight',
  serverMs: 'server-response-time',
}
const PAGES = ['home', 'product', 'category'] as const

/** The middle value, or the mean of the two middle ones; null for none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// ─── AC-1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Dyadic values, so a mean of two is exact whichever way it is computed. */
const arbMetric = fc.option(
  fc.integer({ min: 0, max: 4_000_000 }).map((n) => n / 1024),
  { nil: null },
)
const arbOk: fc.Arbitrary<LighthouseSample> = fc
  .record({
    performance: arbMetric,
    lcpMs: arbMetric,
    cls: arbMetric,
    tbtMs: arbMetric,
    bytes: arbMetric,
    serverMs: arbMetric,
  })
  .map((metrics) => ({ ok: true as const, metrics }))
const arbFailed: fc.Arbitrary<LighthouseSample> = fc
  .tuple(
    fc.constantFrom(
      'HTTP 403',
      'timed out after 120 s',
      'ERRORED_DOCUMENT_REQUEST: (Status code: 404)',
      'not the mobile preset',
      'exit 1',
    ),
    fc.nat(),
  )
  .map(([reason, n]) => ({ ok: false as const, reason: `${reason} #${n}` }))
const arbRuns = fc.array(fc.oneof(arbOk, arbFailed), { maxLength: 9 })

describe("AC-1: a side's medians", () => {
  it("AC-1: per metric, the median is of the non-null values over the ok runs only, the same in any order; it is null with no ok run, and then the reason is the first failure's; runs come back as given", () => {
    fc.assert(
      fc.property(
        arbRuns.chain((runs) =>
          fc.tuple(
            fc.constant(runs),
            fc.shuffledSubarray(runs, { minLength: runs.length, maxLength: runs.length }),
          ),
        ),
        fc.option(fc.constantFrom('https://shop.example/', 'http://localhost:4321/'), {
          nil: null,
        }),
        ([runs, shuffled], url) => {
          const given = structuredClone(runs)
          const side: LighthouseSide = summariseSide(url, runs)
          const ok = runs.flatMap((r) => (r.ok ? [r.metrics] : []))

          const failures = runs.flatMap((r) => (r.ok ? [] : [r.reason]))
          const expected =
            ok.length === 0
              ? { median: null, reason: failures[0] ?? 'no run measured' }
              : {
                  median: Object.fromEntries(
                    METRICS.map((m) => [
                      m,
                      median(ok.flatMap((metrics) => (metrics[m] === null ? [] : [metrics[m]]))),
                    ]),
                  ),
                  reason: null,
                }

          expect({ url: side.url, runs: side.runs }).toEqual({ url, runs: given })
          expect({ median: side.median, reason: side.reason }).toEqual(expected)
          expect(summariseSide(url, shuffled).median).toEqual(side.median)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-1: two ok runs give the mean of the two for each metric, and a failed run between them counts as nothing', () => {
    const sample = (v: number): LighthouseSample => ({
      ok: true,
      metrics: {
        performance: v,
        lcpMs: v * 10,
        cls: v / 100,
        tbtMs: v,
        bytes: v * 1000,
        serverMs: v,
      },
    })
    const runs = [sample(40), { ok: false as const, reason: 'timed out after 120 s' }, sample(90)]

    const side = summariseSide('https://shop.example/', runs)

    expect(side.median).toEqual({
      performance: (40 + 90) / 2,
      lcpMs: (400 + 900) / 2,
      cls: (0.4 + 0.9) / 2,
      tbtMs: (40 + 90) / 2,
      bytes: (40_000 + 90_000) / 2,
      serverMs: (40 + 90) / 2,
    })
  })
})

// ─── AC-2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Lhr {
  lighthouseVersion: string
  runtimeError?: { code: string; message: string }
  configSettings: { formFactor: string; throttlingMethod: string }
  categories: { performance?: { score: number | null } }
  audits: Record<string, { numericValue?: number }>
}

/** A drawn value: absent from the result, present with no value, or a number. */
type Drawn = 'absent' | 'no value' | number

const arbDrawnValue: fc.Arbitrary<Drawn> = fc.oneof(
  fc.constantFrom<Drawn>('absent', 'no value'),
  fc.double({ min: 0, max: 1e7, noNaN: true, noDefaultInfinity: true }),
)
const arbDrawn = fc.record({
  score: fc.oneof(
    fc.constantFrom<Drawn>('absent', 'no value'),
    fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
  ),
  lcpMs: arbDrawnValue,
  cls: arbDrawnValue,
  tbtMs: arbDrawnValue,
  bytes: arbDrawnValue,
  serverMs: arbDrawnValue,
})
type DrawnLhr = typeof arbDrawn extends fc.Arbitrary<infer T> ? T : never

function lhrOf(
  drawn: DrawnLhr,
  settings = { formFactor: 'mobile', throttlingMethod: 'simulate' },
): Lhr {
  const audits: Lhr['audits'] = {}
  for (const [metric, id] of Object.entries(AUDIT_OF)) {
    const v = drawn[metric as keyof typeof AUDIT_OF]
    if (v === 'absent') continue
    audits[id] = v === 'no value' ? {} : { numericValue: v }
  }
  return {
    lighthouseVersion: '12.6.1',
    configSettings: settings,
    categories:
      drawn.score === 'absent'
        ? {}
        : { performance: { score: drawn.score === 'no value' ? null : drawn.score } },
    audits,
  }
}

describe('AC-2: reading one Lighthouse result', () => {
  it("AC-2: the recorded result of a page gives its score × 100 and the five audits' values", () => {
    const lhr = readFixture('lhr-ok.json') as Lhr & {
      categories: { performance: { score: number } }
      audits: Record<string, { numericValue: number }>
    }

    const sample = readLighthouseResult(lhr)

    expect(sample.ok).toBe(true)
    if (!sample.ok) return
    expect(sample.metrics).toEqual({
      performance: Math.round(lhr.categories.performance.score * 100),
      lcpMs: lhr.audits['largest-contentful-paint']!.numericValue,
      cls: lhr.audits['cumulative-layout-shift']!.numericValue,
      tbtMs: lhr.audits['total-blocking-time']!.numericValue,
      bytes: lhr.audits['total-byte-weight']!.numericValue,
      serverMs: lhr.audits['server-response-time']!.numericValue,
    })
  })

  it('AC-2: the recorded result of a page answering 404 is a failed run naming ERRORED_DOCUMENT_REQUEST and 404, not a score', () => {
    const sample = readLighthouseResult(readFixture('lhr-404.json'))

    expect(sample.ok).toBe(false)
    if (sample.ok) return
    expect(sample.reason).toContain('ERRORED_DOCUMENT_REQUEST')
    expect(sample.reason).toContain('404')
  })

  it('AC-2: for drawn results, the metrics are the drawn values, and a missing score or value is null', () => {
    fc.assert(
      fc.property(arbDrawn, (drawn) => {
        const sample = readLighthouseResult(lhrOf(drawn))

        expect(sample.ok).toBe(true)
        if (!sample.ok) return
        const value = (v: Drawn) => (typeof v === 'number' ? v : null)
        expect(sample.metrics).toEqual({
          performance: typeof drawn.score === 'number' ? Math.round(drawn.score * 100) : null,
          lcpMs: value(drawn.lcpMs),
          cls: value(drawn.cls),
          tbtMs: value(drawn.tbtMs),
          bytes: value(drawn.bytes),
          serverMs: value(drawn.serverMs),
        })
      }),
      { numRuns: 300 },
    )
  })

  it("AC-2: any runtimeError makes the run failed, with '<code>: <message>' as its reason, whatever the result holds", () => {
    fc.assert(
      fc.property(
        arbDrawn,
        fc.constantFrom(
          'ERRORED_DOCUMENT_REQUEST',
          'NO_FCP',
          'PROTOCOL_TIMEOUT',
          'FAILED_DOCUMENT_REQUEST',
        ),
        fc.string({ minLength: 1, maxLength: 40 }),
        (drawn, code, message) => {
          const lhr = { ...lhrOf(drawn), runtimeError: { code, message } }

          expect(readLighthouseResult(lhr)).toEqual({ ok: false, reason: `${code}: ${message}` })
        },
      ),
    )
  })

  it('AC-2: a result measured with another form factor or throttling is refused as not the mobile preset', () => {
    fc.assert(
      fc.property(
        arbDrawn,
        fc
          .record({
            formFactor: fc.constantFrom('mobile', 'desktop'),
            throttlingMethod: fc.constantFrom('simulate', 'devtools', 'provided'),
          })
          .filter((s) => !(s.formFactor === 'mobile' && s.throttlingMethod === 'simulate')),
        (drawn, settings) => {
          expect(readLighthouseResult(lhrOf(drawn, settings))).toEqual({
            ok: false,
            reason: 'not the mobile preset',
          })
        },
      ),
    )
  })

  it('AC-2: anything that is not an object with audits is no Lighthouse result', () => {
    const notResults: unknown[] = [
      null,
      undefined,
      42,
      'lighthouse',
      [],
      {},
      { lighthouseVersion: '12.6.1', categories: { performance: { score: 0.9 } } },
      { audits: null, configSettings: { formFactor: 'mobile', throttlingMethod: 'simulate' } },
    ]

    expect(notResults.map((r) => readLighthouseResult(r))).toEqual(
      notResults.map(() => ({ ok: false, reason: 'no Lighthouse result' })),
    )
  })
})

// ─── AC-3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const USERINFO = 'ck_userinfo_7f3a:cs_userinfo_9b2e'
const QUERY = 'consumer_key=ck_query_51d0&consumer_secret=cs_query_e8c4'
const HASH = 'frag_6a1f'
const SECRETS = ['ck_userinfo_7f3a', 'cs_userinfo_9b2e', 'ck_query_51d0', 'cs_query_e8c4', HASH]

const arbSlug = fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/)
const arbSourceUrl = fc
  .record({
    scheme: fc.constantFrom('http', 'https'),
    host: fc.constantFrom('shop.example', 'store.test', '127.0.0.1:8080', 'localhost:8888'),
    path: fc.constantFrom('', '/', '/store', '/shop/en/'),
    userinfo: fc.boolean(),
    query: fc.boolean(),
    hash: fc.boolean(),
  })
  .map(
    (u) =>
      `${u.scheme}://${u.userinfo ? `${USERINFO}@` : ''}${u.host}${u.path}${u.query ? `?${QUERY}` : ''}${u.hash ? `#${HASH}` : ''}`,
  )
const arbStorefront = fc
  .tuple(
    fc.constantFrom('http://localhost', 'http://127.0.0.1'),
    fc.integer({ min: 1024, max: 65535 }),
  )
  .map(([host, port]) => `${host}:${port}`)
/** Categories first, then products, as the redirect map lists them; either kind may be absent. */
const arbRows: fc.Arbitrary<RedirectRow[]> = fc
  .tuple(
    fc.array(fc.tuple(arbSlug, arbSlug), { maxLength: 4 }),
    fc.array(fc.tuple(fc.constantFrom('/product/', '/shop/'), arbSlug, arbSlug), { maxLength: 4 }),
  )
  .map(([categories, products]) => [
    ...categories.map(([wc, n]) => ({
      from: `/product-category/${wc}/`,
      to: `/category/${n}`,
      status: 301 as const,
    })),
    ...products.map(([base, wc, n]) => ({
      from: `${base}${wc}/`,
      to: `/product/${n}`,
      status: 301 as const,
    })),
  ])

describe('AC-3: the pages each pair compares', () => {
  it("AC-3: home is --url's origin and path against the storefront's /, product and category are the first row of each kind (from on --url's origin against storefront + to), an absent kind has no URLs and its reason, and no URL carries --url's userinfo, query or hash", () => {
    fc.assert(
      fc.property(arbSourceUrl, arbStorefront, arbRows, (sourceUrl, storefrontOrigin, rows) => {
        const url = new URL(sourceUrl)
        const pairOf = (page: 'product' | 'category', prefix: string, none: string) => {
          const row = rows.find((r) => r.to.startsWith(prefix))
          return row === undefined
            ? { page, source: null, preview: null, reason: none }
            : {
                page,
                source: new URL(row.from, url.origin).href,
                preview: `${storefrontOrigin}${row.to}`,
                reason: null,
              }
        }

        const pairs = lighthousePairs({ sourceUrl, storefrontOrigin, rows })

        expect(pairs).toEqual([
          {
            page: 'home',
            source: `${url.origin}${url.pathname}`,
            preview: `${storefrontOrigin}/`,
            reason: null,
          },
          pairOf('product', '/product/', 'no listed product'),
          pairOf('category', '/category/', 'no category'),
        ])
        const text = JSON.stringify(pairs)
        expect(SECRETS.filter((s) => text.includes(s))).toEqual([])
      }),
      { numRuns: 300 },
    )
  })
})

// ─── AC-4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const fixed = readFixture('report-without-lighthouse.json') as {
  report: Omit<PreviewReport, 'lighthouse'>
  markdown: string
}
const SEVEN = [
  '## Counts',
  '## Review before launch',
  '## Errors',
  '## Differences',
  '## Not on the storefront',
  '## Redirects',
  '## Unmapped fields',
]
const TABLE_HEADER =
  '| Page | Side | URL | Performance | LCP | CLS | TBT | Transferred | Server response |'

const headings = (markdown: string) => markdown.split('\n').filter((l) => l.startsWith('## '))
/** A Markdown table row's cells, an escaped pipe kept inside its cell. */
const cells = (row: string) =>
  row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim())
/** Everything from `## Lighthouse` on. */
const lighthouseText = (markdown: string) => {
  const at = markdown.indexOf('\n## Lighthouse\n')
  return at < 0 ? '' : markdown.slice(at + 1)
}

/** Milliseconds whose rounding is not a tie: an integer plus at most .40. */
const arbMs = fc
  .tuple(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 0, max: 40 }))
  .map(([ms, hundredths]) => ms + hundredths / 100)
/** A CLS whose fourth decimal is below 5, so three decimals are not a tie. */
const arbCls = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 4 }))
  .map(([thousandths, rest]) => (thousandths * 10 + rest) / 10_000)
const arbBytes = fc.integer({ min: 0, max: 5_000_000 }).filter((b) => b % 1024 !== 512)
const arbMedian = fc.record({
  performance: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
  lcpMs: fc.option(arbMs, { nil: null }),
  cls: fc.option(arbCls, { nil: null }),
  tbtMs: fc.option(arbMs, { nil: null }),
  bytes: fc.option(arbBytes, { nil: null }),
  serverMs: fc.option(arbMs, { nil: null }),
})
const arbSide = (url: string): fc.Arbitrary<LighthouseSide> =>
  fc.oneof(
    arbMedian.map((median) => ({
      url,
      runs: [{ ok: true as const, metrics: median }],
      median,
      reason: null,
    })),
    fc
      .tuple(
        fc.boolean(),
        fc.constantFrom(
          'HTTP 403',
          'timed out after 10 s',
          'warm-up timed out after 10 s',
          'ERRORED_DOCUMENT_REQUEST: (Status code: 404)',
        ),
      )
      .map(([hasUrl, reason]) => ({
        url: hasUrl ? url : null,
        runs: [{ ok: false as const, reason }],
        median: null,
        reason,
      })),
  )
const arbSection: fc.Arbitrary<LighthouseSection> = fc.record({
  lighthouseVersion: fc.constantFrom('12.6.1', '12.8.0'),
  formFactor: fc.constant('mobile' as const),
  throttling: fc.constant('simulate' as const),
  runs: fc.integer({ min: 1, max: 9 }),
  benchmarkIndex: fc.integer({ min: 100, max: 5000 }),
  pairs: fc.tuple(
    ...PAGES.map((page) =>
      fc.record({
        page: fc.constant(page),
        source: arbSide(`https://shop.example/${page}/`),
        preview: arbSide(`http://localhost:4321/${page}`),
      }),
    ),
  ) as fc.Arbitrary<LighthousePair[]>,
})

/** The cells a side's row must show after its URL, by the report's formatting rules. */
function expectedCells(side: LighthouseSide): Array<string | RegExp> {
  if (side.median === null) return [`n/a (${side.reason})`, '—', '—', '—', '—', '—']
  const m = side.median
  const ms = (v: number | null) => (v === null ? '—' : new RegExp(`^${Math.round(v)}( ms)?$`))
  return [
    m.performance === null ? 'n/a (no score)' : String(Math.round(m.performance)),
    ms(m.lcpMs),
    m.cls === null ? '—' : m.cls.toFixed(3),
    ms(m.tbtMs),
    m.bytes === null ? '—' : `${Math.round(m.bytes / 1024)} KiB`,
    ms(m.serverMs),
  ]
}

/** A side's URL cell holds its URL; a side with none may show anything there. */
const urlCell = (url: string | null): unknown =>
  url === null ? expect.any(String) : expect.stringContaining(url)
const cellMatcher = (e: string | RegExp): unknown =>
  typeof e === 'string' ? e : expect.stringMatching(e)

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("AC-4: the report's Lighthouse section", () => {
  it('AC-4: with lighthouse null the report is, byte for byte, the seven-section report it was, and has no ## Lighthouse', () => {
    const markdown = formatPreviewReport({ ...fixed.report, lighthouse: null }, 'Shop')

    expect(markdown).toBe(fixed.markdown)
    expect(headings(markdown)).toEqual(SEVEN)
  })

  it('AC-4: for drawn sections, ## Lighthouse comes last after the unchanged seven sections; its first line names the version, mobile, simulated throttling and the run count; each pair has a source row then a preview row, each cell formatted by the rules, a side that did not measure showing n/a and its reason; two closing lines name the differences', () => {
    fc.assert(
      fc.property(arbSection, (section) => {
        const markdown = formatPreviewReport({ ...fixed.report, lighthouse: section }, 'Shop')
        const text = lighthouseText(markdown)

        expect(headings(markdown)).toEqual([...SEVEN, '## Lighthouse'])
        expect(markdown.slice(0, markdown.indexOf('## Lighthouse')).trimEnd()).toBe(
          fixed.markdown.trimEnd(),
        )

        const lines = text
          .split('\n')
          .slice(1)
          .filter((l) => l.trim() !== '')
        const opening = lines[0]!
        expect(opening).toContain(`Lighthouse ${section.lighthouseVersion}`)
        expect(opening).toContain('mobile')
        expect(opening).toContain('simulated throttling')
        expect(opening).toMatch(new RegExp(`median of ${section.runs} run`))
        expect(opening).toContain(`benchmark index ${section.benchmarkIndex}`)

        const tableAt = lines.indexOf(TABLE_HEADER)
        expect(tableAt).toBe(1)
        const rows = lines.slice(tableAt + 2, tableAt + 8)
        const sides = section.pairs.flatMap((pair) => [
          { page: pair.page, side: 'source', value: pair.source },
          { page: pair.page, side: 'preview', value: pair.preview },
        ])
        expect(rows.map(cells).map((c) => [c[0]!.toLowerCase(), c[1]!.toLowerCase()])).toEqual(
          sides.map((s) => [s.page, s.side]),
        )
        expect(rows.map((row) => cells(row).slice(2))).toEqual(
          sides.map(({ value }) => [urlCell(value.url), ...expectedCells(value).map(cellMatcher)]),
        )

        const closing = lines.slice(tableAt + 8)
        expect(closing).toHaveLength(2)
        const said = closing.join('\n')
        for (const difference of [
          /server response/i,
          /compress/i,
          /HTTP\/1\.1/,
          /origin/i,
          /CDN/,
          /resiz/i,
        ]) {
          expect(said).toMatch(difference)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('AC-4: a CLS of 0.0123 shows 0.012, 1536 bytes show 2 KiB, a side refused with HTTP 403 shows n/a (HTTP 403) and dashes, and a side with no score shows n/a (no score)', () => {
    const measured = {
      performance: 87,
      lcpMs: 2412.3,
      cls: 0.0123,
      tbtMs: 180.2,
      bytes: 1536,
      serverMs: 640.1,
    }
    const side = (median: LighthouseSide['median'], reason: string | null): LighthouseSide => ({
      url: 'https://shop.example/',
      runs: [],
      median,
      reason,
    })
    const section: LighthouseSection = {
      lighthouseVersion: '12.6.1',
      formFactor: 'mobile',
      throttling: 'simulate',
      runs: 3,
      benchmarkIndex: 2940,
      pairs: [
        {
          page: 'home',
          source: side(measured, null),
          preview: side({ ...measured, performance: null }, null),
        },
        { page: 'product', source: side(null, 'HTTP 403'), preview: side(measured, null) },
        { page: 'category', source: side(measured, null), preview: side(measured, null) },
      ],
    }

    const rows = lighthouseText(
      formatPreviewReport({ ...fixed.report, lighthouse: section }, 'Shop'),
    )
      .split('\n')
      .filter((l) => l.startsWith('|'))
      .slice(2)
      .map(cells)

    expect(rows[0]!.slice(3)).toEqual([
      '87',
      expect.stringMatching(/^2412( ms)?$/),
      '0.012',
      expect.stringMatching(/^180( ms)?$/),
      '2 KiB',
      expect.stringMatching(/^640( ms)?$/),
    ])
    expect(rows[1]![3]).toBe('n/a (no score)')
    expect(rows[2]!.slice(3)).toEqual(['n/a (HTTP 403)', '—', '—', '—', '—', '—'])
  })

  it('AC-4: the JSON writePreview writes parses back to the same lighthouse section', async () => {
    await fc.assert(
      fc.asyncProperty(arbSection, async (section) => {
        const dir = mkdtempSync(join(tmpdir(), 'preview-lighthouse-'))
        scratch.push(dir)

        const paths = await writePreview({ ...fixed.report, lighthouse: section }, [], dir, 'Shop')

        const written = JSON.parse(readFileSync(paths.json, 'utf8')) as { lighthouse: unknown }
        expect(written.lighthouse).toEqual(section)
      }),
      { numRuns: 25 },
    )
  })
})
