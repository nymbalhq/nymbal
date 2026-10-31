import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { shell } from './work-tree-copy'

// A real Vitest run in a copy of the work tree, read back from its JSON report: one row per test, and one row for each
// file that failed before any test ran (a failed import, a throw at collection).

export interface TestRow {
  /** Relative to the directory Vitest ran in. */
  file: string
  name: string
  status: string
  messages: string[]
}

export interface VitestReport {
  code: number
  output: string
  tests: TestRow[]
}

interface JsonReport {
  testResults: Array<{
    name: string
    status: string
    message?: string
    assertionResults: Array<{ fullName: string; status: string; failureMessages?: string[] }>
  }>
}

/**
 * A copy's node_modules are this checkout's, linked. pnpm, finding a manifest the copy changed, installs before it runs
 * a script, and would write that install into this checkout: every command a test runs in a copy starts with this.
 */
export const NO_INSTALL = 'pnpm_config_verify_deps_before_run=false'

/** `vitest run <args>` in `cwd` from its bin, with a JSON report in place of the configured reporters. */
export async function vitestReport(cwd: string, args: string): Promise<VitestReport> {
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-vitest-report-'))
  const out = join(dir, 'report.json')
  try {
    const run = await shell(
      cwd,
      `${NO_INSTALL} node_modules/.bin/vitest run ${args} --reporter=json --outputFile.json=${out}`,
    )
    if (!existsSync(out)) {
      throw new Error(`no Vitest report from: vitest run ${args}\n${run.output.slice(-3000)}`)
    }
    const report = JSON.parse(readFileSync(out, 'utf8')) as JsonReport
    const tests = report.testResults.flatMap((file): TestRow[] => {
      const rel = relative(cwd, file.name)
      const rows = file.assertionResults.map((t) => ({
        file: rel,
        name: t.fullName,
        status: t.status,
        messages: t.failureMessages ?? [],
      }))
      if (rows.length > 0 || file.status !== 'failed') return rows
      return [{ file: rel, name: '(collection)', status: 'failed', messages: [file.message ?? ''] }]
    })
    return { code: run.code, output: run.output, tests }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const failedRows = (report: VitestReport): TestRow[] =>
  report.tests.filter((t) => t.status === 'failed')

export const rowKey = (row: TestRow): string => `${row.file} > ${row.name}`

/** How many of the rows under `prefix` ended in each status. */
export function statusCounts(report: VitestReport, prefix: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of report.tests.filter((r) => r.file.startsWith(prefix))) {
    counts[t.status] = (counts[t.status] ?? 0) + 1
  }
  return counts
}
