import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import * as gate from '../../scripts/gate'
import {
  cleanupScratch,
  gateCli,
  GATE_PACKAGE_JSON,
  type Scratch,
  scratchRepo,
  TSX,
  write,
} from './scratch-gate'

// Acceptance tests for P1-20 (spec P1-20-loop-waits-less), AC-2: a ratchet change re-measures only the files whose
// entry moved. `ratchetChanges(base, head)`, exported by scripts/gate.ts, takes the text of the base's and the head's
// mutation-ratchet.json and returns the files whose `files` entry was added or changed. When the ratchet differs from
// the base, the gate adds those files to the files Stryker mutates, and the stryker step drops their mutants from
// reports/mutation/stryker-incremental.json before Stryker runs, so they are measured fresh while every other file
// keeps its cached statuses. With identical ratchets the plan is today's.
// The CLI runs in a scratch repository; `pnpm` is a stand-in that logs its calls and, when called to run Stryker,
// copies the incremental report as Stryker would find it. `pnpm exec tsx` goes to the real tsx.

afterEach(cleanupScratch)

type RatchetChanges = (base: string, head: string) => string[]
const ratchetChanges = (base: string, head: string): string[] =>
  (gate as unknown as { ratchetChanges: RatchetChanges }).ratchetChanges(base, head)

const ratchet = (files: Record<string, number>, measuredAt = '2026-10-18T16:26:26.438Z'): string =>
  `${JSON.stringify({ measuredAt, command: 'pnpm mutation --force', total: 55.7, files }, null, 2)}\n`

const A = 'packages/platform/src/services/a-service.ts'
const B = 'packages/platform/src/services/b-service.ts'

describe('AC-2: ratchetChanges', () => {
  it("AC-2: ratchets that differ only in A's entry name A alone", () => {
    expect(ratchetChanges(ratchet({ [A]: 50, [B]: 60 }), ratchet({ [A]: 70, [B]: 60 }))).toEqual([
      A,
    ])
  })

  it('AC-2: property: the result is exactly the head entries that are new or moved, whatever else the file says', () => {
    const paths = [
      A,
      B,
      'packages/platform/src/repositories/cart.ts',
      'packages/platform/src/db/json.ts',
    ]
    const entries = fc.dictionary(
      fc.constantFrom(...paths),
      fc.integer({ min: 0, max: 10_000 }).map((n) => n / 100),
    )
    fc.assert(
      fc.property(entries, entries, fc.boolean(), (base, head, restamp) => {
        const expected = Object.keys(head)
          .filter((path) => !(path in base) || base[path] !== head[path])
          .sort()
        const headText = ratchet(head, restamp ? '2026-10-19T09:00:00.000Z' : undefined)
        expect([...ratchetChanges(ratchet(base), headText)].sort()).toEqual(expected)
      }),
      { numRuns: 300 },
    )
  })
})

// --- the gate CLI on a scratch repository -----------------------------------------------------------------------

const INCREMENTAL = 'reports/mutation/stryker-incremental.json'
const AT_RUN = 'incremental-at-stryker-run.json'
const STRYKER_CONFIG = [
  'export default {',
  "  mutate: ['packages/platform/src/**/*.ts', '!packages/platform/src/**/*.test.ts'],",
  '  incremental: true,',
  `  incrementalFile: '${INCREMENTAL}',`,
  '}',
  '',
].join('\n')

const STAND_IN = `#!/usr/bin/env bash
echo "pnpm $*" >>"$SCRATCH/calls.log"
if [ "$1" = exec ] && [ "$2" = tsx ]; then shift 2; exec '${TSX}' "$@"; fi
if [[ " $* " == *" stryker run "* ]]; then
  if [ -f ${INCREMENTAL} ]; then cp ${INCREMENTAL} "$SCRATCH/${AT_RUN}"; else echo absent >"$SCRATCH/${AT_RUN}"; fi
fi
exit 0
`

type Mutant = { id: string; mutatorName: string; status: string; location: object }
type Incremental = {
  files: Record<string, { language: string; source: string; mutants: Mutant[] }>
}

const mutants = (prefix: string): Mutant[] =>
  ['Killed', 'Survived', 'NoCoverage'].map((status, i) => ({
    id: `${prefix}${i}`,
    mutatorName: 'BlockStatement',
    status,
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 20 } },
  }))

const INCREMENTAL_REPORT: Incremental = {
  files: {
    [A]: { language: 'typescript', source: 'export const a = 1\n', mutants: mutants('a') },
    [B]: { language: 'typescript', source: 'export const b = 1\n', mutants: mutants('b') },
  },
}

function strykerRepo(): Scratch {
  const repo = scratchRepo({
    'package.json': GATE_PACKAGE_JSON,
    'stryker.config.mjs': STRYKER_CONFIG,
    'mutation-ratchet.json': ratchet({ [A]: 50, [B]: 60 }),
    'packages/platform/package.json': JSON.stringify({ name: '@nymbalhq/platform' }),
    [A]: 'export const a = 1\n',
    [B]: 'export const b = 1\n',
  })
  writeFileSync(join(repo.bin, 'pnpm'), STAND_IN)
  chmodSync(join(repo.bin, 'pnpm'), 0o755)
  // The cache restores the report into an ignored path, as in CI.
  write(repo.root, INCREMENTAL, `${JSON.stringify(INCREMENTAL_REPORT)}\n`)
  return repo
}

const ARGS = ['--full', '--only', 'stryker', '--no-build', '--base', 'HEAD', '--json']

/** The files each Stryker run was given with `--mutate`. */
const mutateArgs = (repo: Scratch): string[][] =>
  repo
    .calls()
    .filter((c) => /\bstryker run\b/.test(c))
    .map((c) => {
      const m = /--mutate[= ]+(?:'([^']*)'|(\S+))/.exec(c)
      return (m?.[1] ?? m?.[2] ?? '').split(',').filter(Boolean).sort()
    })

const atRun = (repo: Scratch): Incremental | 'absent' | 'not run' => {
  const path = join(repo.root, AT_RUN)
  if (!existsSync(path)) return 'not run'
  const text = readFileSync(path, 'utf8')
  return text.trim() === 'absent' ? 'absent' : (JSON.parse(text) as Incremental)
}

describe('AC-2: the stryker step after a ratchet change', () => {
  it("AC-2: a change to A's ratchet entry alone mutates A, and Stryker finds the report without A's mutants and with B's", async () => {
    const repo = strykerRepo()
    write(
      repo.root,
      'mutation-ratchet.json',
      ratchet({ [A]: 70, [B]: 60 }, '2026-10-19T09:00:00.000Z'),
    )
    const run = await gateCli(repo, ARGS)
    expect(mutateArgs(repo), run.output).toEqual([[A]])
    const report = atRun(repo)
    expect(report, run.output).not.toBe('absent')
    if (typeof report === 'string') return
    expect(report.files[A]?.mutants ?? []).toEqual([])
    expect(report.files[B]).toEqual(INCREMENTAL_REPORT.files[B])
  })

  it("AC-2: with identical ratchets, a change to A's source mutates A alone and leaves the report as the cache restored it", async () => {
    const repo = strykerRepo()
    const before = readFileSync(join(repo.root, INCREMENTAL), 'utf8')
    write(repo.root, A, 'export const a = 2\n')
    const run = await gateCli(repo, ARGS)
    expect(mutateArgs(repo), run.output).toEqual([[A]])
    expect(readFileSync(join(repo.root, AT_RUN), 'utf8')).toBe(before)
  })

  it('AC-2: with identical ratchets and nothing in the mutate set changed, the step stays skipped', async () => {
    const repo = strykerRepo()
    write(repo.root, 'docs/notes.md', 'notes\n')
    const run = await gateCli(repo, ARGS)
    expect(run.steps.find((s) => s.name === 'stryker')?.status, run.output).toBe('skipped')
    expect(mutateArgs(repo), run.output).toEqual([])
  })
})
