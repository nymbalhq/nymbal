// Reads: .github/workflows/nightly.yml, stryker.config.mjs, scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupScratch,
  gateCli,
  GATE_PACKAGE_JSON,
  git,
  REPO,
  type Scratch,
  scratchRepo,
  write,
} from './scratch-gate'
import { parseYaml } from './workflow-yaml'

// The incremental report is measured at one commit, which the stamp beside it names. A run that restores an older
// report than its base would report a file changed in between, left out of a `--mutate` narrowed to the base diff,
// with statuses from before its change (a dev run read refresh-token.ts at 63.83 from such a report, against 68.42
// measured on its own push). So the stryker step mutates whatever changed since the stamp as well as since its base.
// The nightly full run writes the stamp beside the report it caches. The CLI and the stamp step run in a scratch
// repository whose `pnpm` is a stand-in that logs its calls and exits 0.

afterEach(cleanupScratch)

const INCREMENTAL = 'reports/mutation/stryker-incremental.json'
const STAMP = 'reports/mutation/stryker-incremental.commit'
const A = 'packages/platform/src/services/a-service.ts'
const B = 'packages/platform/src/services/b-service.ts'
const C = 'packages/platform/src/services/c-service.ts'

const STRYKER_CONFIG = [
  'export default {',
  "  mutate: ['packages/platform/src/**/*.ts', '!packages/platform/src/**/*.test.ts'],",
  '  incremental: true,',
  `  incrementalFile: '${INCREMENTAL}',`,
  '}',
  '',
].join('\n')

const commit = (root: string, message: string): string => {
  git(root, 'add', '-A')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD').trim()
}

/** A repository whose cached report was measured at its first commit, which the stamp names. */
function stampedRepo(): { repo: Scratch; measuredAt: string } {
  const repo = scratchRepo({
    'package.json': GATE_PACKAGE_JSON,
    'stryker.config.mjs': STRYKER_CONFIG,
    'packages/platform/package.json': JSON.stringify({ name: '@nymbalhq/platform' }),
    [A]: 'export const a = 1\n',
    [B]: 'export const b = 1\n',
    [C]: 'export const c = 1\n',
  })
  const measuredAt = git(repo.root, 'rev-parse', 'HEAD').trim()
  write(repo.root, INCREMENTAL, `${JSON.stringify({ files: {} })}\n`)
  write(repo.root, STAMP, `${measuredAt}\n`)
  return { repo, measuredAt }
}

const args = (base: string): string[] => [
  '--full',
  '--only',
  'stryker',
  '--no-build',
  '--base',
  base,
  '--json',
]

/** The mutate-set files that differ between `from` and HEAD, sorted. */
const changedSince = (root: string, from: string): string[] =>
  git(root, 'diff', '--name-only', from, 'HEAD')
    .split('\n')
    .filter((p) => p.startsWith('packages/platform/src/'))
    .sort()

/** The files each Stryker run was given with `--mutate`. */
const mutateArgs = (repo: Scratch): string[][] =>
  repo
    .calls()
    .filter((c) => /\bstryker run\b/.test(c))
    .map((c) => {
      const m = /--mutate[= ]+(?:'([^']*)'|(\S+))/.exec(c)
      return (m?.[1] ?? m?.[2] ?? '').split(',').filter(Boolean).sort()
    })

describe('the stryker step when the cached report is behind its base', () => {
  it("mutates the files changed since the report's commit as well as this push's, when that commit predates the base", async () => {
    const { repo, measuredAt } = stampedRepo()
    // A push after the measured commit, whose report was never saved.
    write(repo.root, A, 'export const a = 2\n')
    const redPush = commit(repo.root, 'red push')
    write(repo.root, B, 'export const b = 2\n')
    commit(repo.root, 'this push')
    const run = await gateCli(repo, args(redPush))
    expect(mutateArgs(repo), run.output).toEqual([[A, B]])
    expect(mutateArgs(repo)).toEqual([changedSince(repo.root, measuredAt)])
    expect(mutateArgs(repo)[0]?.length).toBeGreaterThan(changedSince(repo.root, redPush).length)
  })

  it('mutates only the base diff when the report was measured at the base', async () => {
    const { repo, measuredAt } = stampedRepo()
    write(repo.root, B, 'export const b = 2\n')
    commit(repo.root, 'this push')
    const run = await gateCli(repo, args(measuredAt))
    expect(mutateArgs(repo), run.output).toEqual([[B]])
  })

  it('mutates the whole mutate set when the report names a commit this clone does not have', async () => {
    const { repo, measuredAt } = stampedRepo()
    write(repo.root, STAMP, `${'f'.repeat(40)}\n`)
    write(repo.root, B, 'export const b = 2\n')
    commit(repo.root, 'this push')
    const run = await gateCli(repo, args(measuredAt))
    expect(mutateArgs(repo), run.output).toEqual([[A, B, C]])
  })
})

type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, string> }

function jobSteps(workflow: string, job: string): Step[] {
  const wf = parseYaml(readFileSync(join(REPO, '.github/workflows', workflow), 'utf8')) as {
    jobs?: Record<string, { steps?: Step[] }>
  }
  return wf.jobs?.[job]?.steps ?? []
}

const cachePaths = (s: Step | undefined): string[] =>
  (s?.with?.path ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)

const writesStamp = (s: Step): boolean => (s.run ?? '').includes(STAMP)

describe('the nightly full run caches its incremental report with a stamp', () => {
  const nightly = (): Step[] => jobSteps('nightly.yml', 'mutation-full')
  const fullRun = (all: Step[]): number => all.findIndex((s) => /\bmutation --force\b/.test(s.run ?? ''))
  const seed = (all: Step[]): number => all.findIndex((s) => /^actions\/cache\/save@/.test(s.uses ?? ''))

  // Stryker writes the incremental file whenever `incremental` is on, `--force` included; `--force` only skips reading it.
  it("the file the nightly caches is the incremental file Stryker's config writes", () => {
    const config = readFileSync(join(REPO, 'stryker.config.mjs'), 'utf8')
    expect(config).toMatch(/\bincremental: true\b/)
    const file = /\bincrementalFile: '([^']+)'/.exec(config)?.[1]
    expect(file).toBe(INCREMENTAL)
    const all = nightly()
    expect(cachePaths(all[seed(all)])).toContain(file)
  })

  it('saves the report and its stamp after the full run and whatever the ratchet check says', () => {
    const all = nightly()
    const run = fullRun(all)
    const save = seed(all)
    const ratchet = all.findIndex((s) => /\bmutation:ratchet check\b/.test(s.run ?? ''))
    expect(run).toBeGreaterThanOrEqual(0)
    expect(save).toBeGreaterThan(run)
    expect(save < ratchet || /\balways\(\)/.test(all[save]?.if ?? '')).toBe(true)
    expect(cachePaths(all[save]).sort()).toEqual([INCREMENTAL, STAMP].sort())
    expect(all[save]?.with?.key ?? '').toMatch(/^stryker-incremental-v3-nightly-/)
  })

  it('stamps HEAD after the full run and before the save, so the next run diffs from the night\'s commit', async () => {
    const all = nightly()
    const stamp = all.findIndex(writesStamp)
    expect(stamp).toBeGreaterThan(fullRun(all))
    expect(stamp).toBeLessThan(seed(all))
    const { repo, measuredAt } = stampedRepo()
    write(repo.root, A, 'export const a = 2\n')
    const night = commit(repo.root, 'nightly head')
    execFileSync('bash', ['-ec', all[stamp]?.run ?? ''], { cwd: repo.root, stdio: 'pipe' })
    expect(readFileSync(join(repo.root, STAMP), 'utf8').trim()).toBe(night)
    expect(night).not.toBe(measuredAt)
    write(repo.root, B, 'export const b = 2\n')
    const push = commit(repo.root, 'next push')
    const next = await gateCli(repo, args(push))
    expect(mutateArgs(repo), next.output).toEqual([[B]])
  })
})
