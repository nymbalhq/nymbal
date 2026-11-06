// Reads: .github/workflows/ci.yml, .github/workflows/nightly.yml, stryker.config.mjs, scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts
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

// The incremental report is measured at one commit, and CI caches it only when the mutation job passes. After a red
// run the next run restores a report older than its base, so a file changed by the red run's push, left out of a
// `--mutate` narrowed to the base diff, is reported with statuses from before its change (a dev run read
// refresh-token.ts at 63.83 from such a report, against 68.42 measured on its own push). After a passing mutation
// step the job records the commit beside the report, and the next run mutates whatever changed since that commit as
// well as since its base. The CLI and the job's stamp step run in a scratch repository whose `pnpm` is a stand-in that
// logs its calls and exits 0.

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

describe('the stryker step after a red run left the cached report behind its base', () => {
  it("mutates the red push's files as well as this push's, when the report's commit predates the base", async () => {
    const { repo, measuredAt } = stampedRepo()
    // The red push: its job failed, so no report was saved at it.
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

const mutationSteps = (): Step[] => jobSteps('ci.yml', 'mutation')

const cachePaths = (s: Step | undefined): string[] =>
  (s?.with?.path ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)

const writesStamp = (s: Step): boolean => (s.run ?? '').includes(STAMP)

describe("the mutation job's cache", () => {
  it('saves and restores the commit stamp with the incremental report', () => {
    const paths = mutationSteps()
      .filter((s) => /^actions\/cache@/.test(s.uses ?? ''))
      .flatMap((s) => (s.with?.path ?? '').split('\n').map((p) => p.trim()))
    expect(paths).toContain(INCREMENTAL)
    expect(paths).toContain(STAMP)
  })

  it('stamps the report only after the mutation step, and only when it passed', () => {
    const all = mutationSteps()
    const mutation = all.findIndex((s) => /gate\.ts --full --only stryker\b/.test(s.run ?? ''))
    const stamp = all.findIndex(writesStamp)
    expect(mutation).toBeGreaterThanOrEqual(0)
    expect(stamp).toBeGreaterThan(mutation)
    expect(all[stamp]?.if).toBeUndefined()
  })

  it("the stamp step records HEAD beside the report, and the next run diffs from it", async () => {
    const run = mutationSteps().find(writesStamp)?.run ?? ''
    expect(run).not.toBe('')
    const { repo, measuredAt } = stampedRepo()
    write(repo.root, A, 'export const a = 2\n')
    const head = commit(repo.root, 'this push')
    execFileSync('bash', ['-ec', run], { cwd: repo.root, stdio: 'pipe' })
    expect(readFileSync(join(repo.root, STAMP), 'utf8').trim()).toBe(head)
    expect(head).not.toBe(measuredAt)
    write(repo.root, B, 'export const b = 2\n')
    commit(repo.root, 'next push')
    const next = await gateCli(repo, args(head))
    expect(mutateArgs(repo), next.output).toEqual([[B]])
  })
})

describe("the nightly full run seeds the push mutation job's cache", () => {
  const nightly = (): Step[] => jobSteps('nightly.yml', 'mutation-full')
  const fullRun = (all: Step[]): number => all.findIndex((s) => /\bmutation --force\b/.test(s.run ?? ''))
  const seed = (all: Step[]): number => all.findIndex((s) => /^actions\/cache\/save@/.test(s.uses ?? ''))

  // Stryker writes the incremental file whenever `incremental` is on, `--force` included; `--force` only skips reading it.
  it("the file the push job restores is the incremental file Stryker's config writes", () => {
    const config = readFileSync(join(REPO, 'stryker.config.mjs'), 'utf8')
    expect(config).toMatch(/\bincremental: true\b/)
    const file = /\bincrementalFile: '([^']+)'/.exec(config)?.[1]
    expect(file).toBe(INCREMENTAL)
    expect(cachePaths(mutationSteps().find((s) => /^actions\/cache@/.test(s.uses ?? '')))).toContain(file)
  })

  it("saves the report and its stamp under a key of its own that the push job's restore prefix matches, after the full run and whatever the ratchet check says", () => {
    const all = nightly()
    const run = fullRun(all)
    const save = seed(all)
    const ratchet = all.findIndex((s) => /\bmutation:ratchet check\b/.test(s.run ?? ''))
    expect(run).toBeGreaterThanOrEqual(0)
    expect(save).toBeGreaterThan(run)
    expect(save < ratchet || /\balways\(\)/.test(all[save]?.if ?? '')).toBe(true)
    expect(cachePaths(all[save]).sort()).toEqual([INCREMENTAL, STAMP].sort())

    const restore = mutationSteps().find((s) => /^actions\/cache@/.test(s.uses ?? ''))
    expect(cachePaths(restore).sort()).toEqual(cachePaths(all[save]).sort())
    const key = all[save]?.with?.key ?? ''
    const prefix = restore?.with?.['restore-keys'] ?? ''
    expect(prefix).not.toBe('')
    expect(key.startsWith(prefix)).toBe(true)
    // A push that passed at the same sha saves under its own exact key; a shared key would drop the full measurement.
    expect(key).not.toBe(restore?.with?.key)
  })

  it('stamps HEAD after the full run and before the save, so the next push diffs from the night\'s commit', async () => {
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
