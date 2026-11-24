// Reads: package.json, vitest.config.ts
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { type PlanInput, plan, type StepSpec } from '../../scripts/gate'

// AC-8: the timing-bound tests run in projects of their own, as gate steps of their own.

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))

const PERF_FILE = 'packages/platform/tests/integration/search-performance.test.ts'
const PERF_POSTGRES_FILE = 'packages/platform/tests/postgres/search-performance.postgres.test.ts'

const BASE: PlanInput = { full: false, base: 'abc1234', changed: [], mutated: [] }

/** The steps that would run (not skipped) in a plan. */
const running = (steps: StepSpec[]): string[] =>
  steps.filter((step) => step.skip === undefined).map((step) => step.name)

/** The Vitest projects that collect each file, from `vitest list --filesOnly` with these arguments. */
async function collecting(args: string[]): Promise<Map<string, string[]>> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_TEST_')) env[key] = value
  }
  const { stdout } = await exec(
    join(REPO, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json', ...args],
    { cwd: REPO, env, maxBuffer: 64 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{
    file: string
    projectName?: string
  }>
  const byFile = new Map<string, string[]>()
  for (const { file, projectName } of rows) {
    const path = relative(REPO, file)
    byFile.set(path, [...(byFile.get(path) ?? []), projectName ?? ''])
  }
  return byFile
}

/** Shell words of a command line: plain words and single- or double-quoted ones, as package.json scripts write them. */
function words(command: string): string[] {
  return [...command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)
}

/** The Vitest arguments of the sentinel suite: what follows `vitest run` in the `sentinels` script's `--suite`. */
function sentinelSuiteArgs(): string[] {
  const scripts = (
    JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
  const sentinels = words(scripts['sentinels'] ?? '')
  const suite = sentinels[sentinels.indexOf('--suite') + 1] ?? ''
  const suiteWords = words(suite)
  const at = suiteWords.indexOf('run')
  expect(suiteWords.slice(at - 1, at + 1)).toEqual(['vitest', 'run'])
  return suiteWords.slice(at + 1)
}

describe('AC-8: the timing-bound tests run apart, in steps of their own', () => {
  it('AC-8 (a): plan({ full: true }) runs perf and perf-postgres as steps of their own', () => {
    const { steps } = plan({ ...BASE, full: true, mutated: ['packages/sdk/src/client.ts'] })
    const names = steps.map((step) => step.name)
    expect(running(steps)).toEqual(expect.arrayContaining(['perf', 'perf-postgres']))
    // perf-postgres reads the composed Postgres, so it comes after compose up.
    expect(names.indexOf('perf-postgres')).toBeGreaterThan(names.indexOf('compose up'))
  })

  it('AC-8 (b): each timing-bound file is in exactly its own project, and the sentinel suite collects neither', async () => {
    const projects = await collecting([])
    expect(projects.get(PERF_FILE)).toEqual(['perf'])
    expect(projects.get(PERF_POSTGRES_FILE)).toEqual(['integration-postgres-perf'])
    const sentinelSuite = await collecting(sentinelSuiteArgs())
    // The suite still collects the rest of platform-integration: only the timing-bound files leave it.
    const integration = [...projects].filter(([, names]) => names.includes('platform-integration'))
    expect(integration.length).toBeGreaterThan(0)
    expect(integration.filter(([file]) => !sentinelSuite.has(file))).toEqual([])
    expect([PERF_FILE, PERF_POSTGRES_FILE].filter((file) => sentinelSuite.has(file))).toEqual([])
  })

  it('AC-8 (c): the plain gate leaves perf to gate:full, even when search-service.ts changed, and its tests step still leaves the timing-bound file out', () => {
    const changed = ['packages/platform/src/services/search-service.ts']
    const search = plan({ ...BASE, changed })
    const perf = search.steps.find((s) => s.name === 'perf')!
    // Still a row, skipped: the Stop hook's plain-gate check reads every plain step's name in the record.
    expect(perf.skip).toMatch(/gate:full/)
    expect(running(search.steps)).not.toContain('perf')
    expect(search.steps.find((s) => s.name === 'tests')!.command).toContain(
      `--exclude ${PERF_FILE}`,
    )
    // The plain gate never starts Postgres, so it never runs perf-postgres.
    expect(running(search.steps)).not.toContain('perf-postgres')
    const full = plan({ ...BASE, full: true, changed, mutated: changed })
    expect(running(full.steps)).toContain('perf')
    const readme = plan({ ...BASE, full: true, changed: ['README.md'] })
    expect(running(readme.steps)).toContain('perf')
  })
})
