import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupScratch, gateCli, git, scratchRepo, write } from './scratch-gate'

// Acceptance tests for P1-17 (spec P1-17-loop-asks-what-user-sees), AC-16, the gate half (the Stop-hook half is in
// nymbal-ops tests/gate-hooks.test.sh): every gate run writes reports/last-run.json, and `--rerun-red` runs only
// the steps that were red and, inside `tests`, only the red tests. It always exits non-zero with
// `rerun: <n> green, <m> red, not a gate verdict`, and prints `flaky: <id>` for a test that goes green while the
// diff is unchanged since the red run.
// The real plain gate runs in a scratch repository with real pnpm and Vitest. Its lint and typecheck scripts log
// each run; typecheck is red while TC_RED=1. Its one test file holds `steady` (always green) and `flips` (red while
// RED=1); each test logs its name when it runs. Logs live outside the tree, so they never move the diff.

afterEach(cleanupScratch)

const LOGGER = `const fs = require('node:fs')
const step = process.argv[2]
fs.appendFileSync(process.env.STEP_LOG, step + '\\n')
process.exit(step === 'typecheck' && process.env.TC_RED === '1' ? 1 : 0)
`

const TESTS = `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('steady', () => {
  appendFileSync(process.env.TEST_LOG ?? '/dev/null', 'steady\\n')
  expect(1 + 1).toBe(2)
})

test('flips', () => {
  appendFileSync(process.env.TEST_LOG ?? '/dev/null', 'flips\\n')
  expect(process.env.RED === '1' ? 1 : 2).toBeGreaterThan(1)
})
`

type Repo = ReturnType<typeof scratchRepo> & { base: string; stepLog: string; testLog: string }

function rerunRepo(): Repo {
  const repo = scratchRepo(
    {
      'package.json': JSON.stringify({
        name: 'rerun-scratch',
        private: true,
        scripts: {
          lint: 'node log.cjs lint',
          typecheck: 'node log.cjs typecheck',
          test: 'vitest run',
        },
      }),
      'log.cjs': LOGGER,
      'src/other.ts': 'export const other = 1\n',
      // gate.ts reads packages/ for the proof-kit closure before any step runs.
      'packages/lib/package.json': JSON.stringify({ name: 'lib' }),
    },
    { realModules: true },
  )
  const base = git(repo.root, 'rev-parse', 'HEAD')
  write(repo.root, 'src/a.test.ts', TESTS)
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'tests')
  return {
    ...repo,
    base,
    stepLog: join(repo.root, '..', `${repo.root.split('/').pop()}-steps.log`),
    testLog: join(repo.root, '..', `${repo.root.split('/').pop()}-tests.log`),
  }
}

const read = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []

function clearLogs(repo: Repo): void {
  rmSync(repo.stepLog, { force: true })
  rmSync(repo.testLog, { force: true })
}

async function gate(
  repo: Repo,
  args: string[],
  env: Record<string, string>,
): ReturnType<typeof gateCli> {
  return gateCli(
    repo,
    ['--base', repo.base, ...args],
    { STEP_LOG: repo.stepLog, TEST_LOG: repo.testLog, ...env },
    false,
  )
}

type LastRun = {
  sha?: string
  diffHash?: string
  steps?: Record<string, string>
  vitest?: Array<{ file: string; name: string }>
}

async function redRun(repo: Repo): Promise<LastRun> {
  const run = await gate(repo, [], { RED: '1', TC_RED: '1' })
  expect(run.code, run.output).toBe(1)
  // The scratch is red for the designed reasons only: typecheck, and the flips test.
  expect(run.output).toMatch(/^ok\s+lint\b/m)
  expect(run.output).toMatch(/^red\s+typecheck\b/m)
  expect(run.output).toMatch(/^red\s+tests\b/m)
  expect(run.output).toMatch(/^ok\s+census trend\b/m)
  const path = join(repo.root, 'reports/last-run.json')
  expect(existsSync(path), `reports/last-run.json after a red run\n${run.output}`).toBe(true)
  return JSON.parse(readFileSync(path, 'utf8')) as LastRun
}

describe('AC-16: --rerun-red re-runs only what was red, and is never a verdict', () => {
  it('AC-16: last-run.json records the run; --rerun-red runs only typecheck and the one red test, prints flaky, and exits non-zero', async () => {
    const repo = rerunRepo()
    const last = await redRun(repo)
    expect(last.sha).toBe(git(repo.root, 'rev-parse', 'HEAD'))
    expect((last.diffHash ?? '').length).toBeGreaterThan(0)
    expect(last.steps).toMatchObject({ lint: 'ok', typecheck: 'red', tests: 'red' })
    expect((last.vitest ?? []).map((t) => t.name)).toEqual(['flips'])
    expect((last.vitest ?? [])[0]?.file ?? '').toMatch(/(^|\/)src\/a\.test\.ts$/)

    clearLogs(repo)
    const rerun = await gate(repo, ['--rerun-red'], {})
    expect(read(repo.stepLog), rerun.output).toEqual(['typecheck'])
    expect(read(repo.testLog), rerun.output).toEqual(['flips'])
    expect(rerun.output).toMatch(/^rerun: [1-9]\d* green, 0 red, not a gate verdict$/m)
    expect(rerun.output).toMatch(/^flaky: .*flips/m)
    expect(rerun.code ?? 0, rerun.output).toBeGreaterThan(0)
  }, 120_000)

  it('AC-16: with the diff changed since the red run, a test that goes green is not called flaky; the exit is still non-zero', async () => {
    const repo = rerunRepo()
    await redRun(repo)
    write(repo.root, 'src/other.ts', 'export const other = 2\n')
    clearLogs(repo)
    const rerun = await gate(repo, ['--rerun-red'], {})
    expect(read(repo.testLog), rerun.output).toEqual(['flips'])
    expect(rerun.output).toMatch(/^rerun: [1-9]\d* green, 0 red, not a gate verdict$/m)
    expect(rerun.output).not.toMatch(/^flaky:/m)
    expect(rerun.code ?? 0, rerun.output).toBeGreaterThan(0)
  }, 120_000)
})
