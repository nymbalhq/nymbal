import type { RedirectRow } from './types.js'

// How a preview reads Lighthouse results and pairs the source's pages with the preview's. No I/O: the CLI runs
// Lighthouse and hands the results here.

export type LighthouseMetric = 'performance' | 'lcpMs' | 'cls' | 'tbtMs' | 'bytes' | 'serverMs'

export type LighthouseSample =
  | {
      ok: true
      metrics: Record<LighthouseMetric, number | null>
      lighthouseVersion?: string
      benchmarkIndex?: number | null
    }
  | { ok: false; reason: string }

export interface LighthouseSide {
  url: string | null
  runs: LighthouseSample[]
  median: Record<LighthouseMetric, number | null> | null
  reason: string | null
}

export type LighthousePage = 'home' | 'product' | 'category'

export interface LighthousePair {
  page: LighthousePage
  source: LighthouseSide
  preview: LighthouseSide
}

export interface LighthouseSection {
  lighthouseVersion: string
  formFactor: 'mobile'
  throttling: 'simulate'
  runs: number
  benchmarkIndex: number | null
  pairs: LighthousePair[]
}

export const LIGHTHOUSE_METRICS: readonly LighthouseMetric[] = [
  'performance',
  'lcpMs',
  'cls',
  'tbtMs',
  'bytes',
  'serverMs',
]

const AUDITS: ReadonlyArray<[Exclude<LighthouseMetric, 'performance'>, string]> = [
  ['lcpMs', 'largest-contentful-paint'],
  ['cls', 'cumulative-layout-shift'],
  ['tbtMs', 'total-blocking-time'],
  ['bytes', 'total-byte-weight'],
  ['serverMs', 'server-response-time'],
]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const numberOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** One Lighthouse result (its JSON output) as a sample: its metrics, or why it measured nothing. */
export function readLighthouseResult(lhr: unknown): LighthouseSample {
  if (!isRecord(lhr) || !isRecord(lhr['audits']))
    return { ok: false, reason: 'no Lighthouse result' }
  const error = lhr['runtimeError']
  if (isRecord(error)) {
    return { ok: false, reason: `${String(error['code'])}: ${String(error['message'])}` }
  }
  const settings = isRecord(lhr['configSettings']) ? lhr['configSettings'] : {}
  if (settings['formFactor'] !== 'mobile' || settings['throttlingMethod'] !== 'simulate') {
    return { ok: false, reason: 'not the mobile preset' }
  }

  const audits = lhr['audits']
  const categories = isRecord(lhr['categories']) ? lhr['categories'] : {}
  const performance = isRecord(categories['performance']) ? categories['performance'] : {}
  const score = numberOrNull(performance['score'])
  const metrics = { performance: score === null ? null : Math.round(score * 100) } as Record<
    LighthouseMetric,
    number | null
  >
  for (const [metric, id] of AUDITS) {
    const audit = audits[id]
    metrics[metric] = isRecord(audit) ? numberOrNull(audit['numericValue']) : null
  }
  const environment = isRecord(lhr['environment']) ? lhr['environment'] : {}
  return {
    ok: true,
    metrics,
    ...(typeof lhr['lighthouseVersion'] === 'string' && {
      lighthouseVersion: lhr['lighthouseVersion'],
    }),
    benchmarkIndex: numberOrNull(environment['benchmarkIndex']),
  }
}

/** The middle value, or the mean of the two middle ones; null for none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** One side of a pair: per metric, the median over the runs that measured it. */
export function summariseSide(url: string | null, runs: LighthouseSample[]): LighthouseSide {
  const measured = runs.flatMap((r) => (r.ok ? [r.metrics] : []))
  if (measured.length === 0) {
    const failed = runs.find((r) => !r.ok)
    return {
      url,
      runs,
      median: null,
      reason: failed === undefined || failed.ok ? 'no run measured' : failed.reason,
    }
  }
  const medians = Object.fromEntries(
    LIGHTHOUSE_METRICS.map((m) => [
      m,
      median(measured.flatMap((metrics) => (metrics[m] === null ? [] : [metrics[m]]))),
    ]),
  ) as Record<LighthouseMetric, number | null>
  return { url, runs, median: medians, reason: null }
}

export interface PlannedPair {
  page: LighthousePage
  source: string | null
  preview: string | null
  reason: string | null
}

/**
 * The three pages compared: the store's home against the preview's, and the first listed product and the first
 * category of the redirect map, each one WooCommerce record against its import. Nothing of `sourceUrl` past its path
 * (userinfo, query, hash) reaches a URL.
 */
export function lighthousePairs(input: {
  sourceUrl: string
  storefrontOrigin: string
  rows: RedirectRow[]
}): PlannedPair[] {
  const url = new URL(input.sourceUrl)
  const pairOf = (page: 'product' | 'category', prefix: string, none: string): PlannedPair => {
    const row = input.rows.find((r) => r.to.startsWith(prefix))
    return row === undefined
      ? { page, source: null, preview: null, reason: none }
      : {
          page,
          source: new URL(row.from, url.origin).href,
          preview: `${input.storefrontOrigin}${row.to}`,
          reason: null,
        }
  }
  return [
    {
      page: 'home',
      source: `${url.origin}${url.pathname}`,
      preview: `${input.storefrontOrigin}/`,
      reason: null,
    },
    pairOf('product', '/product/', 'no listed product'),
    pairOf('category', '/category/', 'no category'),
  ]
}

/** The report's section: the Lighthouse version and benchmark index come from the first run that measured. */
export function lighthouseSection(runs: number, pairs: LighthousePair[]): LighthouseSection {
  let first: Extract<LighthouseSample, { ok: true }> | undefined
  for (const pair of pairs) {
    for (const sample of [...pair.source.runs, ...pair.preview.runs]) {
      if (first === undefined && sample.ok) first = sample
    }
  }
  return {
    lighthouseVersion: first?.lighthouseVersion ?? 'unknown',
    formFactor: 'mobile',
    throttling: 'simulate',
    runs,
    benchmarkIndex: first?.benchmarkIndex ?? null,
    pairs,
  }
}
