import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportReport, ImportState } from './types.js'

/**
 * Counts the source records brought over since the last `--fresh`: a customer linked to one the store already had is
 * imported, though the rollback set holds only the records the import created.
 */
export function buildReport(state: ImportState, startMs: number): ImportReport {
  const count = (map: Record<string, string>) => Object.keys(map).length
  return {
    imported: {
      categories: count(state.wcToNymbalCategory),
      products: count(state.wcToNymbalProduct),
      customers: count(state.wcToNymbalCustomer),
      orders: count(state.wcToNymbalOrder),
      reviews: count(state.wcToNymbalReview),
    },
    enriched: { enriched: 0, skipped: 0, failed: 0 },
    errors: state.errors,
    warnings: state.warnings,
    updated: { products: state.delta?.updated.products ?? 0 },
    changedNotUpdated: { orders: state.delta?.changedNotUpdated.orders ?? 0 },
    eventsEmitted: state.eventsEmitted,
    durationMs: Date.now() - startMs,
  }
}

export function formatReport(report: ImportReport, storeName: string): string {
  const mins = Math.round(report.durationMs / 60000)
  const secs = Math.round((report.durationMs % 60000) / 1000)
  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  const lines: string[] = [
    `# Nymbal Migration Report — ${storeName}`,
    `_Generated ${new Date().toISOString()}_`,
    '',
    '## Import Summary',
    '',
    `| Entity | Imported |`,
    `|---|---|`,
    `| Categories | ${report.imported.categories} |`,
    `| Products | ${report.imported.products} |`,
    `| Customers | ${report.imported.customers} |`,
    `| Orders | ${report.imported.orders} |`,
    `| Reviews | ${report.imported.reviews} |`,
    '',
    '## AI Enrichment',
    '',
    `- Products enriched: **${report.enriched.enriched}**`,
    `- Products skipped (content sufficient): ${report.enriched.skipped}`,
    `- Enrichment failures: ${report.enriched.failed}`,
    '',
    '## Pipeline Stats',
    '',
    `- Events emitted: ${report.eventsEmitted}`,
    `- Duration: ${duration}`,
    '',
  ]

  if (report.updated.products > 0 || report.changedNotUpdated.orders > 0) {
    lines.push('## Changes since', '')
    for (const [entity, since] of Object.entries(report.since ?? {})) {
      const label = entity.charAt(0).toUpperCase() + entity.slice(1)
      lines.push(`- ${label}: ${since === null ? 'everything (first pass)' : `since ${since}`}`)
    }
    lines.push(
      `- Updated products: ${report.updated.products}`,
      `- Changed orders not updated: ${report.changedNotUpdated.orders} (an imported order is never written again)`,
      '',
    )
  }

  if (report.errors.length > 0) {
    lines.push('## Errors Requiring Review', '')
    for (const e of report.errors) {
      lines.push(`- **${e.phase}**${e.id ? ` (${e.id})` : ''}: ${e.error}`)
    }
    lines.push('')
  }

  if (report.warnings.length > 0) {
    lines.push('## Review before launch', '')
    for (const w of report.warnings) {
      lines.push(`- **${w.phase}**${w.id ? ` (${w.id})` : ''}: ${w.message}`)
    }
    lines.push('')
  }

  lines.push(
    '## Next Steps',
    '',
    '1. Run `nymbal dev` to preview your imported store',
    '2. Run `nymbal test:visual --update-baselines` to capture visual baselines',
    '3. Review any items listed under Errors and Review before launch above',
    ...(report.enriched.skipped > 0
      ? ['4. Products with sufficient content were skipped — review originals if needed']
      : []),
  )

  return lines.join('\n')
}

export async function writeReport(report: ImportReport, projectRoot: string, storeName: string): Promise<string> {
  const content = formatReport(report, storeName)
  const path = join(projectRoot, 'nymbal-migration-report.md')
  await writeFile(path, content, 'utf-8')
  return path
}
