import { rebuildReports } from '../../src/reports/rebuild.js'
import type { Kernel } from './kernel.js'
import { ZONE } from './report-rollups.js'

// The rebuild as the CLI calls it, over a test kernel's store, and its table counts in one order.

/** The rebuild over the kernel's store, in the store's zone. */
export function rebuildOn(
  k: Pick<Kernel, 'store' | 'repos'>,
  retentionDays: number,
  options: { now?: Date; dryRun?: boolean } = {},
) {
  return rebuildReports({ store: k.store, repos: k.repos, timeZone: ZONE, retentionDays }, options)
}

export interface TableCounts {
  name: string
  rows: number
  added: number
  changed: number
  removed: number
}

/** The tables' counts in one order, whatever order the rebuild lists them in. */
export function countsOf(report: { tables: TableCounts[] }): TableCounts[] {
  return [...report.tables]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, rows: t.rows, added: t.added, changed: t.changed, removed: t.removed }))
}
