// Reads: tests/tooling/ci-workflow.test.ts, tests/tooling/sentinel-select.test.ts, tests/tooling/store-sets.test.ts
// Reads: tests/tooling/mutation-ratchet.test.ts, tests/tooling/gate-ratchet.test.ts, tests/tooling/stryker-targets.test.ts
// Reads: tests/tooling/mutation-ratchet-integration.test.ts, tests/tooling/census-guard-step.test.ts
// Reads: tests/tooling/census-journey.test.ts, tests/tooling/census-journey-helpers.test.ts
// Reads: tests/tooling/gate-base-fallback.test.ts, tests/tooling/gate-e2e-outputs.test.ts
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { changedFiles, HARNESS_PROJECTS, harnessInputTests, plan } from '../../scripts/gate'
import { gitIn, removeCopies, resetCopy, selectedFiles, workTreeCopy } from './work-tree-copy'

// The plain gate's tests step selects a test for a change to a file it reads or runs from disk, not only for one its
// imports reach. Each case changes one thing in a copy of the work tree and asks Vitest itself, running the step's
// command, which files it collects. AC-1 runs Vitest once per input, so it runs only under NYMBAL_SLOW_CASES
// (vitest.config.ts; the nightly's harness-tests job); AC-3 runs on every push.

const tooling = (name: string): string => `tests/tooling/${name}.test.ts`
const PERF = 'packages/platform/tests/integration/search-performance.test.ts'

const CASES: Array<{ path: string; readers: string[] }> = [
  { path: '.github/workflows/nightly.yml', readers: ['ci-workflow', 'store-sets'].map(tooling) },
  { path: 'mutation-ratchet.json', readers: [tooling('mutation-ratchet')] },
  {
    path: 'stryker.config.mjs',
    readers: [
      'ci-workflow',
      'gate-ratchet',
      'mutation-ratchet',
      'mutation-ratchet-integration',
      'stryker-targets',
    ].map(tooling),
  },
  { path: 'scripts/mutation-ratchet.ts', readers: [tooling('mutation-ratchet')] },
  {
    path: 'scripts/gate.ts',
    readers: [
      'census-guard-step',
      'census-journey',
      'census-journey-helpers',
      'gate-base-fallback',
      'gate-e2e-outputs',
    ].map(tooling),
  },
]

let dir = ''
let head = ''
let toolingProject: string[] = []
const slow = Boolean(process.env['NYMBAL_SLOW_CASES'])

beforeAll(() => {
  dir = workTreeCopy()
  head = gitIn(dir, 'rev-parse', 'HEAD').trim()
  // The tooling project's files, by its include glob (vitest.config.ts).
  toolingProject = gitIn(dir, 'ls-files', ':(glob)tests/tooling/**/*.test.ts')
    .split('\n')
    .filter(Boolean)
}, 120_000)

afterAll(removeCopies)

/** What the plain gate's tests step selects for the copy's change, beside the readers `main` hands it. */
async function stepSelection(): Promise<{ files: string[]; readers: string[]; command: string }> {
  const related = changedFiles(dir, head, { renames: false })
  const readers = harnessInputTests(dir, related)
  const step = plan({
    full: false,
    base: head,
    changed: changedFiles(dir, head),
    relatedPaths: related,
    mutated: [],
    inputReaders: readers,
  }).steps.find((s) => s.name === 'tests')
  if (step === undefined || step.skip !== undefined) {
    throw new Error(`the plain gate plans no tests run for ${related.join(', ')}`)
  }
  return { files: await selectedFiles(dir, step.command), readers, command: step.command }
}

const toolingOf = (files: string[]): string[] => files.filter((f) => f.startsWith('tests/tooling/'))

describe('AC-1: a non-code input or a spawned script selects the tests that read or run it', () => {
  it.runIf(slow)(
    'AC-1: through Vitest, each input changed alone selects its readers, and fewer files than the tooling project',
    async () => {
      const rows: string[] = []
      const sizes: Array<{ path: string; selected: number }> = []
      for (const { path, readers } of CASES) {
        appendFileSync(join(dir, path), '\n')
        try {
          const { files } = await stepSelection()
          const missing = readers.filter((r) => !files.includes(r))
          rows.push(
            `${path}: ${missing.length === 0 ? 'selected' : `misses ${missing.join(', ')}`}`,
          )
          sizes.push({ path, selected: toolingOf(files).length })
        } finally {
          resetCopy(dir)
        }
      }
      expect(rows).toEqual(CASES.map((c) => `${c.path}: selected`))
      for (const { path, selected } of sizes) {
        expect(selected, `${path} selects part of the tooling project`).toBeLessThan(
          toolingOf(toolingProject).length,
        )
      }
    },
    300_000,
  )
})

describe('AC-3: the step loses nothing the changed-files run selected', () => {
  it('AC-3: through Vitest, for an unstaged, a staged, an untracked and a deleted change, every file --changed selects is selected, the untracked test too, and each file added is a declared reader', async () => {
    const probe = 'packages/platform/src/services/zz-probe.test.ts'
    appendFileSync(join(dir, 'packages/platform/src/services/cart-service.ts'), '\n')
    appendFileSync(join(dir, 'packages/sdk/src/client.ts'), '\n')
    gitIn(dir, 'add', 'packages/sdk/src/client.ts')
    writeFileSync(
      join(dir, 'packages/platform/src/services/zz-probe.ts'),
      'export const zzProbe = 1\n',
    )
    writeFileSync(
      join(dir, probe),
      "import { expect, it } from 'vitest'\nimport { zzProbe } from './zz-probe'\n\nit('probes', () => {\n  expect(zzProbe + 1).toBe(2)\n})\n",
    )
    gitIn(dir, 'rm', '--quiet', 'packages/sdk/src/store/cart-store.test.ts')
    try {
      const before = await selectedFiles(
        dir,
        `NYMBAL_VITEST_SKIP_PROJECTS=${HARNESS_PROJECTS.join(',')} pnpm run test --changed ${head} --passWithNoTests --exclude ${PERF}`,
      )
      const { files, readers } = await stepSelection()

      expect(before, 'the changed-files run selects the untracked test').toContain(probe)
      expect(files).toContain(probe)
      expect(before.filter((f) => !files.includes(f))).toEqual([])
      expect(files.filter((f) => !before.includes(f) && !readers.includes(f))).toEqual([])
      expect(readers.filter((r) => !files.includes(r))).toEqual([])
      expect(files.length).toBeGreaterThanOrEqual(before.length)
    } finally {
      resetCopy(dir)
    }
  }, 300_000)
})
