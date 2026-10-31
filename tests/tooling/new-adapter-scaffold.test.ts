// Reads: scripts/new-adapter.ts, package.json, registry/adapters.json, tests/architecture/**, tests/tooling/registry-*
// Reads: tests/contracts/*.test.ts, tests/support/*.ts, packages/adapters/*/*/package.json, vitest.config.ts
import { readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SOURCES, planAdapter } from '../../scripts/new-adapter'
import { REPO, gitIn, removeCopies, resetCopy, shell, workTreeCopy } from './work-tree-copy'
import {
  NO_INSTALL,
  failedRows,
  rowKey,
  statusCounts,
  vitestReport,
  type VitestReport,
} from './vitest-report'

// AC-4, the proof: `pnpm new-adapter <slot> <provider>` in a copy of the work tree, with no hand edit and no install
// (the new package's node_modules linked to its source's), gives a package whose typecheck, own tests and contract
// runner pass, and the architecture project and the registry tests still pass with it once its files are staged; the
// copy changes only where the plan says. The sources keep their fakes in different places, and two of the names are
// hyphenated, which a copy spells three ways. Each case runs within the project's per-test timeout.

const CASES = [
  {
    slot: 'search',
    source: 'algolia',
    provider: 'acme-co',
    fake: 'in the package',
    runners: ['tests/contracts/algolia-search.test.ts'],
  },
  {
    slot: 'shipping',
    source: 'easypost',
    provider: 'acme',
    fake: 'under tests/support',
    runners: ['tests/contracts/easypost-shipping-tracking.test.ts'],
  },
  {
    slot: 'payments',
    source: 'stripe',
    provider: 'acme',
    fake: 'under tests/fixtures',
    runners: ['tests/contracts/stripe-payments.test.ts', 'tests/contracts/stripe-refunds.test.ts'],
  },
  {
    slot: 'security',
    source: 'cloudflare',
    provider: 'acme-co',
    fake: 'in the package',
    runners: ['tests/contracts/cloudflare-security.test.ts'],
  },
] as const

const PROJECTS =
  '--project adapters --project contracts-native --project architecture --project tooling'
/** The architecture project, and the tooling tests that read registry/adapters.json. */
const SHARED = 'tests/architecture/ tests/tooling/registry-'

let copy = ''
/** The sources' own tests and runners, the architecture project and the registry tests, in the unchanged copy. */
let baseline: VitestReport

beforeAll(async () => {
  copy = workTreeCopy()
  const sources = CASES.flatMap((c) => [`packages/adapters/${c.slot}/${c.source}/`, ...c.runners])
  baseline = await vitestReport(copy, `${PROJECTS} ${sources.join(' ')} ${SHARED}`)
}, 180_000)

afterEach(() => {
  // The linked node_modules is ignored, so the reset leaves it: remove the new packages first.
  for (const c of CASES) {
    rmSync(join(copy, 'packages', 'adapters', c.slot, c.provider), { recursive: true, force: true })
  }
  resetCopy(copy)
})

afterAll(removeCopies)

/** A changeset's name is the scaffold's to choose: compare changesets as one kind of path. */
const normalise = (paths: readonly string[]): string[] =>
  paths.map((p) => (/^\.changeset\/[^/]+\.md$/.test(p) ? '.changeset/<name>.md' : p)).sort()

/** What `git status` lists as changed or new in the copy, the lockfile aside. */
const changedPaths = (dir: string): string[] =>
  gitIn(dir, 'status', '--porcelain', '-uall')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => p !== 'pnpm-lock.yaml')

/** Each status's count over the rows of several files. */
const countsOver = (report: VitestReport, files: readonly string[]): Record<string, number> =>
  files
    .map((f) => statusCounts(report, f))
    .reduce<Record<string, number>>((sum, c) => {
      for (const [k, v] of Object.entries(c)) sum[k] = (sum[k] ?? 0) + v
      return sum
    }, {})

describe('AC-4: a scaffolded adapter passes unedited', () => {
  for (const c of CASES) {
    it(`AC-4: pnpm new-adapter ${c.slot} ${c.provider} (its source's fake ${c.fake}) typechecks and passes its own tests, its contract runner, the architecture project and the registry tests, changing only the planned paths`, async () => {
      const dir = `packages/adapters/${c.slot}/${c.provider}`
      const plan = (await Promise.resolve().then(() =>
        planAdapter(
          { slot: c.slot, provider: c.provider } as Parameters<typeof planAdapter>[0],
          copy,
        ),
      )) as { files: Array<{ path: string }>; edits: Array<{ path: string }> }
      const planned = [...plan.files.map((f) => f.path), ...plan.edits.map((e) => e.path)]

      const scaffold = await shell(copy, `${NO_INSTALL} pnpm new-adapter ${c.slot} ${c.provider}`)
      expect(scaffold.code, scaffold.output).toBe(0)
      expect(normalise(changedPaths(copy))).toEqual(normalise(planned))
      // Staged as a contributor stages them: the workspace reads its members from tracked manifests.
      gitIn(copy, 'add', '-A')

      // No install: the new package resolves its dependencies through its source's.
      symlinkSync(
        join(REPO, 'packages', 'adapters', c.slot, c.source, 'node_modules'),
        join(copy, dir, 'node_modules'),
      )
      const typecheckScript =
        (
          JSON.parse(readFileSync(join(copy, dir, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>
          }
        ).scripts?.['typecheck'] ?? 'false'
      const typecheck = await shell(
        join(copy, dir),
        `${NO_INSTALL} PATH="$PWD/node_modules/.bin:$PATH" ${typecheckScript}`,
      )
      expect(typecheck.code, typecheck.output).toBe(0)

      const runners = plan.files.map((f) => f.path).filter((p) => p.startsWith('tests/contracts/'))
      const after = await vitestReport(copy, `${PROJECTS} ${dir}/ ${runners.join(' ')} ${SHARED}`)
      const failedBefore = new Set(failedRows(baseline).map(rowKey))

      expect(
        failedRows(after)
          .filter((t) => !failedBefore.has(rowKey(t)))
          .map((t) => `${rowKey(t)}\n${t.messages.join('\n').slice(0, 1500)}`),
      ).toEqual([])
      // A copy of a working adapter runs what its source runs, to the same ends, less the files the source table
      // leaves out of a copy.
      const sourceDir = `packages/adapters/${c.slot}/${c.source}/`
      const leftOut = (
        SOURCES.find((s) => s.slot === c.slot && s.provider === c.source)?.leaveOut ?? []
      ).map((f) => `${sourceDir}${f}`)
      const kept = { ...baseline, tests: baseline.tests.filter((t) => !leftOut.includes(t.file)) }
      expect(statusCounts(after, `${dir}/`)).toEqual(statusCounts(kept, sourceDir))
      expect(countsOver(after, runners)).toEqual(countsOver(baseline, c.runners))
      expect(countsOver(after, ['tests/architecture/']).passed ?? 0).toBeGreaterThanOrEqual(
        countsOver(baseline, ['tests/architecture/']).passed ?? 0,
      )
    })
  }
})
