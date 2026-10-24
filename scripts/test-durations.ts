import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

// Prints the slowest tests of a Vitest JSON report (`vitest run --reporter=json --outputFile=<file>`) as a
// markdown table: duration in ms, repo-relative file, full test name.

type AssertionResult = {
  fullName?: string
  title?: string
  duration?: number | null
  status?: string
}
type FileResult = { name: string; assertionResults?: AssertionResult[] }
type VitestReport = { testResults?: FileResult[] }

export type SlowTest = { durationMs: number; file: string; name: string }

export function slowestTests(report: VitestReport, root: string, top: number): SlowTest[] {
  const tests: SlowTest[] = []
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      if (typeof test.duration !== 'number') continue
      tests.push({
        durationMs: test.duration,
        file: relative(root, file.name),
        name: test.fullName ?? test.title ?? '(unnamed)',
      })
    }
  }
  return tests.sort((a, b) => b.durationMs - a.durationMs).slice(0, top)
}

export function renderDurations(tests: SlowTest[]): string {
  const lines = ['| ms | file | test |', '|---:|---|---|']
  for (const t of tests) {
    lines.push(`| ${Math.round(t.durationMs)} | ${t.file} | ${t.name.replaceAll('|', '\\|')} |`)
  }
  return lines.join('\n')
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { top: { type: 'string', default: '20' } },
  })
  const [reportPath] = positionals
  const top = Number(values.top)
  if (reportPath === undefined || !Number.isInteger(top) || top < 1) {
    throw new Error('usage: test-durations.ts <vitest-json-report> [--top 20]')
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const report = JSON.parse(readFileSync(resolve(reportPath), 'utf8')) as VitestReport
  process.stdout.write(`${renderDurations(slowestTests(report, root, top))}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
