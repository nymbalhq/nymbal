import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportEntity, PlanEntity } from '../types.js'
import type { LighthouseSection, LighthouseSide } from './lighthouse.js'
import { formatRedirectsCsv } from './redirects.js'
import { DIFF_FIELDS, type PreviewReport, type RedirectRow } from './types.js'

const ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders', 'reviews']
const PLAN_ENTITIES: PlanEntity[] = [...ENTITIES, 'variations']

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/** The preview report as Markdown: counts, what to review, errors, differences, drafts, redirects, unmapped fields. */
export function formatPreviewReport(report: PreviewReport, storeName: string): string {
  const lines: string[] = [
    `# Nymbal Preview Report — ${storeName}`,
    `_Generated ${report.generatedAt} from ${report.source.url} in ${report.currency}. Your store was not changed._`,
    '',
    '## Counts',
    '',
    '| Entity | Source | Planned | Imported | Refused | Skipped | Served |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const e of ENTITIES) {
    const c = report.counts[e]
    const served = c.served === null ? '–' : String(c.served)
    lines.push(
      `| ${e} | ${c.source} | ${c.planned} | ${c.imported} | ${c.refused} | ${c.skipped} | ${served} |`,
    )
  }

  lines.push('', '## Review before launch', '')
  if (report.warnings.length === 0) lines.push('None.')
  for (const w of report.warnings) {
    lines.push(`- **${w.phase}**${w.id ? ` (${w.id})` : ''}: ${w.message}`)
  }

  lines.push('', '## Errors', '')
  if (report.errors.length === 0) lines.push('None.')
  for (const e of report.errors) {
    lines.push(`- **${e.phase}**${e.id ? ` (${e.id})` : ''}: ${e.error}`)
  }

  lines.push('', '## Differences', '')
  if (report.differences.products.length === 0) lines.push('None.')
  for (const field of DIFF_FIELDS) {
    const n = report.differences.byField[field]
    if (n === 0) continue
    lines.push(`### ${field} (${n})`, '', '| Product | Source | Preview |', '|---|---|---|')
    for (const p of report.differences.products) {
      for (const c of p.changes.filter((x) => x.field === field)) {
        lines.push(`| ${cell(p.name)} (${code(p.slug)}) | ${cell(c.source)} | ${cell(c.preview)} |`)
      }
    }
    lines.push('')
  }

  lines.push('', '## Not on the storefront', '')
  if (report.notListed.length === 0) lines.push('None.')
  for (const p of report.notListed) {
    lines.push(`- ${p.name} (${code(p.slug)}, WooCommerce id ${p.wcId}): imported as a draft`)
  }

  lines.push('', '## Redirects', '')
  const { rows, unredirected, duplicates } = report.redirects
  lines.push(`${rows} rows in \`nymbal-redirects.csv\`.`)
  for (const u of unredirected) lines.push(`- No redirect for ${u.kind} ${u.wcId}: ${u.reason}`)
  for (const d of duplicates) {
    lines.push(
      `- ${code(d.from)} is already redirected; not again for WooCommerce ids ${d.wcIds.join(', ')}`,
    )
  }

  lines.push('', '## Unmapped fields', '')
  const unmapped = PLAN_ENTITIES.filter((e) => (report.unmapped[e] ?? []).length > 0)
  if (unmapped.length === 0) lines.push('None.')
  for (const e of unmapped) {
    lines.push(`### ${e}`, '')
    for (const f of report.unmapped[e]) lines.push(`- ${code(f.field)}: ${f.records} records`)
    lines.push('')
  }
  if (report.lighthouse !== null) lines.push(...lighthouseLines(report.lighthouse))
  lines.push('')
  return lines.join('\n')
}

const DASH = '—'
const ms = (v: number | null) => (v === null ? DASH : `${Math.round(v)} ms`)

/** A side's metric cells: its medians, or `n/a (<reason>)` and dashes when it measured nothing. */
function metricCells(side: LighthouseSide): string[] {
  const m = side.median
  if (m === null)
    return [cell(`n/a (${side.reason ?? 'no run measured'})`), ...Array<string>(5).fill(DASH)]
  return [
    m.performance === null ? 'n/a (no score)' : String(Math.round(m.performance)),
    ms(m.lcpMs),
    m.cls === null ? DASH : m.cls.toFixed(3),
    ms(m.tbtMs),
    m.bytes === null ? DASH : `${Math.round(m.bytes / 1024)} KiB`,
    ms(m.serverMs),
  ]
}

function lighthouseLines(section: LighthouseSection): string[] {
  const runs = `${section.runs} run${section.runs === 1 ? '' : 's'}`
  const lines = [
    '',
    '## Lighthouse',
    '',
    `Lighthouse ${section.lighthouseVersion}, mobile, simulated throttling, median of ${runs} a page, measured on this machine (benchmark index ${section.benchmarkIndex ?? 'unknown'}).`,
    '',
    '| Page | Side | URL | Performance | LCP | CLS | TBT | Transferred | Server response |',
    '|---|---|---|---|---|---|---|---|---|',
  ]
  for (const pair of section.pairs) {
    for (const [name, side] of [
      ['source', pair.source],
      ['preview', pair.preview],
    ] as const) {
      const url = side.url === null ? DASH : cell(side.url)
      lines.push(`| ${pair.page} | ${name} | ${url} | ${metricCells(side).join(' | ')} |`)
    }
  }
  lines.push(
    '',
    "Server response is the preview's server on this machine against the store's own host.",
    'The preview serves its pages over HTTP/1.1 without compressing static assets, and its images from its local API on a second origin, without a CDN and without resizing.',
  )
  return lines
}

/** `nymbal-preview-report.json`, `nymbal-preview-report.md` and `nymbal-redirects.csv` in `projectRoot`. */
export async function writePreview(
  report: PreviewReport,
  rows: RedirectRow[],
  projectRoot: string,
  storeName: string,
): Promise<{ json: string; markdown: string; csv: string }> {
  const json = join(projectRoot, 'nymbal-preview-report.json')
  const markdown = join(projectRoot, 'nymbal-preview-report.md')
  const csv = join(projectRoot, 'nymbal-redirects.csv')
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  await writeFile(markdown, formatPreviewReport(report, storeName), 'utf-8')
  await writeFile(csv, formatRedirectsCsv(rows), 'utf-8')
  return { json, markdown, csv }
}
