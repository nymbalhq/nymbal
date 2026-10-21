import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { type PlanInput, plan, type StepSpec } from '../../scripts/gate'

// Acceptance tests for P2-14 AC-8 (review round 1, Decisions 10 and 11): the timing-bound tests run in projects of
// their own, as gate steps under the exclusive hold, and every CPU-heavy step holds a shared one.

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))

const PERF_FILE = 'packages/platform/tests/integration/search-performance.test.ts'
const PERF_POSTGRES_FILE = 'packages/platform/tests/postgres/search-performance.postgres.test.ts'

/** The hold a step is marked to take while it runs (Decision 10). */
type Hold = 'shared' | 'exclusive'
const holdOf = (step: StepSpec): Hold | undefined => (step as StepSpec & { hold?: Hold }).hold

/** Decision 10's steps that load the CPU, besides the `e2e *` steps. */
const SHARED_STEPS = [
  'tests',
  'integration-postgres',
  'proof-kit-services',
  'integration-stores',
  'stryker',
  'sentinels',
  'tests-fail-on-base',
]

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

describe('AC-8: the timing-bound tests run apart, under the quiet lock', () => {
  it('AC-8 (a): plan({ full: true }) marks perf and perf-postgres to hold the exclusive lock, and every step of Decision 10 a shared one', () => {
    const { steps } = plan({ ...BASE, full: true, mutated: ['packages/sdk/src/client.ts'] })
    const names = steps.map((step) => step.name)
    const exclusive = steps.filter((step) => holdOf(step) === 'exclusive').map((s) => s.name)
    expect(exclusive.sort()).toEqual(['perf', 'perf-postgres'])
    const e2e = names.filter((name) => name.startsWith('e2e '))
    expect(e2e.length).toBeGreaterThanOrEqual(3)
    const heavy = [...SHARED_STEPS, ...e2e]
    expect(heavy.filter((name) => !names.includes(name))).toEqual([])
    expect(
      heavy.filter((name) => holdOf(steps.find((s) => s.name === name)!) !== 'shared'),
    ).toEqual([])
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

  it('AC-8 (c): a plain plan runs a perf step when search-service.ts changed, and none when only README.md did', () => {
    const search = plan({ ...BASE, changed: ['packages/platform/src/services/search-service.ts'] })
    expect(running(search.steps)).toContain('perf')
    expect(holdOf(search.steps.find((s) => s.name === 'perf')!)).toBe('exclusive')
    const readme = plan({ ...BASE, changed: ['README.md'] })
    expect(running(readme.steps)).not.toContain('perf')
    // The plain gate never starts Postgres, so it never runs perf-postgres.
    expect(running(search.steps)).not.toContain('perf-postgres')
  })
})
