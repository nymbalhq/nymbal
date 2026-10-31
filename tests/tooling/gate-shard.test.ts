// Reads: scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts
// Reads: package.json, vitest.config.ts
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { type PlanInput, plan, SLOW_HARNESS_PROJECTS, type StepSpec } from '../../scripts/gate'
import {
  ARTEFACT,
  cleanupScratch,
  GATE_PACKAGE_JSON,
  gateCli,
  scratchRepo,
  STRYKER_CONFIG,
} from './scratch-gate'
import { vitestFilters, words } from './vitest-filters'
import { resolvedFiles, vitestCall } from './vitest-shards'

// CI splits the tests step over a matrix of jobs with `gate.ts --shard <i>/<n>`. The flag reaches the tests step's
// Vitest call and no other step, a malformed value stops the gate before any step runs, and the shards together run
// each file the unsharded step runs exactly once, as Vitest's own sequencer cuts them.

afterEach(cleanupScratch)

type Shard = { index: number; count: number }

/** What CI's shard calls hand plan(): `--full --harness all --no-build` with the build artefact present. */
const CI_INPUT: PlanInput = {
  full: true,
  base: 'HEAD',
  changed: [],
  mutated: ['packages/sdk/src/client.ts'],
  harness: 'all',
  noBuild: true,
  artefactPresent: true,
}

const STEP_NAMES = plan(CI_INPUT).steps.map((step) => step.name)

const isShard = (word: string): boolean => word === '--shard' || word.startsWith('--shard=')

function testsStep(steps: StepSpec[]): StepSpec | undefined {
  return steps.find((step) => step.name === 'tests')
}

/** The `--shard` words of the Vitest call a planned tests step makes. */
function vitestShards(steps: StepSpec[]): string[] {
  return vitestCall(testsStep(steps)?.command ?? '').argv.filter(isShard)
}

function shardedPlan(only: string[], shard: Shard): StepSpec[] {
  return plan({ ...CI_INPUT, only, shard }).steps
}

/** The refusal names the flag, the form it takes, the rule on i and n, and the value it got. */
function refusal(value: string): RegExp {
  const quoted = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `--shard\\b[\\s\\S]*<i>/<n>[\\s\\S]*1 (?:≤|<=) i (?:≤|<=) n[\\s\\S]*got "${quoted}"`,
  )
}

describe('AC-1: --shard reaches the tests step only', () => {
  const shards = fc
    .integer({ min: 1, max: 64 })
    .chain((count) =>
      fc.record({ index: fc.integer({ min: 1, max: count }), count: fc.constant(count) }),
    )
  const onlyWithTests = fc
    .subarray(STEP_NAMES.filter((name) => name !== 'tests'))
    .map((rest) => [...rest, 'tests'])

  it('AC-1: for any valid i/n and any --only holding tests, the tests step gains exactly one --shard=i/n on its Vitest call and every other step is the unsharded plan’s', () => {
    fc.assert(
      fc.property(onlyWithTests, shards, (only, shard) => {
        const plain = plan({ ...CI_INPUT, only }).steps
        const sharded = shardedPlan(only, shard)
        expect(vitestShards(sharded)).toEqual([`--shard=${shard.index}/${shard.count}`])
        const plainTests = testsStep(plain)
        const shardedTests = testsStep(sharded)
        expect(words(shardedTests?.command ?? '').filter((word) => !isShard(word))).toEqual(
          words(plainTests?.command ?? ''),
        )
        expect({ ...shardedTests, command: '' }).toEqual({ ...plainTests, command: '' })
        expect(sharded.filter((step) => step.name !== 'tests')).toEqual(
          plain.filter((step) => step.name !== 'tests'),
        )
      }),
    )
  })

  it('AC-1: plan refuses a shard outside 1 ≤ i ≤ n or not in integers, naming the rule and the value, and plans --shard=i/n for one inside', () => {
    const value = fc.oneof(fc.integer({ min: -2, max: 6 }), fc.constant(1.5))
    /** `plans <the tests call's --shard words>`, or `refused: <the message>`. */
    const outcome = (shard: Shard): string => {
      try {
        return `plans ${vitestShards(shardedPlan(['tests'], shard)).join(' ')}`
      } catch (error) {
        return `refused: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    fc.assert(
      fc.property(value, value, (index, count) => {
        const valid =
          Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count
        expect(outcome({ index, count })).toMatch(
          valid ? new RegExp(`^plans --shard=${index}/${count}$`) : refusal(`${index}/${count}`),
        )
      }),
      {
        examples: [
          [0, 3],
          [4, 3],
          [3, 0],
          [2, 3],
          [1, 1],
        ],
      },
    )
  })

  it('AC-1: the CLI refuses 0/3, 4/3, 3/0, x and 1/3/2 before any step runs, naming the rule and the value, and runs 2/3 and 1/1 with that shard on the Vitest call', async () => {
    const refused = ['0/3', '4/3', '3/0', 'x', '1/3/2']
    const accepted = ['2/3', '1/1']
    const runs = await Promise.all(
      [...refused, ...accepted].map(async (value) => {
        const repo = scratchRepo({
          'package.json': GATE_PACKAGE_JSON,
          'stryker.config.mjs': STRYKER_CONFIG,
          ...ARTEFACT,
        })
        const run = await gateCli(repo, [
          '--full',
          '--only',
          'tests',
          '--harness',
          'all',
          '--no-build',
          '--shard',
          value,
          '--base',
          'HEAD',
          '--json',
        ])
        return { value, run, calls: repo.calls() }
      }),
    )
    for (const { value, run, calls } of runs.filter((r) => refused.includes(r.value))) {
      expect(run.output, `--shard ${value}`).toMatch(refusal(value))
      expect({ code: run.code, calls }, run.output).toEqual({ code: 1, calls: [] })
    }
    for (const { value, run, calls } of runs.filter((r) => accepted.includes(r.value))) {
      const vitest = calls.filter((call) => call.startsWith('pnpm run test'))
      expect(
        vitest.map((call) => words(call).filter(isShard)),
        run.output,
      ).toEqual([[`--shard=${value}`]])
      expect(run.code, run.output).toBe(0)
    }
  })
})

describe('AC-2: the shards cover the suite exactly once', () => {
  it('AC-2: the tests calls of shards 1..3, resolved through Vitest’s sequencer, are disjoint and together run the unsharded set, tooling-slow and the perf file included', async () => {
    const count = 3
    const command = (shard?: Shard): string =>
      testsStep(
        plan({ ...CI_INPUT, only: ['tests'], ...(shard === undefined ? {} : { shard }) }).steps,
      )?.command ?? ''
    const [whole = [], ...shards] = await resolvedFiles([
      command(),
      ...Array.from({ length: count }, (_, i) => command({ index: i + 1, count })),
    ])
    const projects = new Set(whole.map((key) => key.slice(0, key.indexOf(':'))))
    expect([...SLOW_HARNESS_PROJECTS, 'perf'].filter((name) => !projects.has(name))).toEqual([])
    // The command's own `--exclude` globs hold, as the Vitest CLI adds them to the config's exclude.
    const excluded = vitestFilters(command()).excludes.map((glob) => glob.replace(/\*\*$/, ''))
    expect(excluded.length, 'the tests call excludes a directory').toBeGreaterThan(0)
    expect(
      whole.filter((key) => excluded.some((prefix) => key.slice(key.indexOf(':') + 1).startsWith(prefix))),
    ).toEqual([])
    const run = shards.flat()
    expect(run.length, 'files run over the shards, against the unsharded run').toBe(whole.length)
    expect([...new Set(run)].sort()).toEqual([...whole].sort())
  })
})
