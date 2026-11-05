// Reads: scripts/release-check.ts, .github/workflows/ci.yml, .github/workflows/nightly.yml, .github/workflows/registry.yml, .github/workflows/quickstart-soak.yml, registry/adapters.json, tests/tooling/fixtures/release-check/*.json
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUDGETS_JOB,
  CI,
  check,
  INTEGRATION_JOBS,
  LIGHTHOUSE_STEP,
  MUTATION_JOBS,
  NIGHTLY,
  NOTED_JOBS,
  REGISTRY,
  REGISTRY_ARTIFACT,
  render,
  SOAK,
  SOAK_JOB_PREFIX,
  SOAK_RUNS,
  STORE_JOBS,
  type Gh,
  type Job,
  type Run,
} from '../../scripts/release-check'
import { parseYaml, type Yaml } from './workflow-yaml'

// The release check reads the runs at the candidate's sha through gh. Here gh is a fake answering from runs recorded
// in the REST API's and gh's own JSON shapes: its run list is not narrowed by `head_sha`, so a check that trusts the
// list instead of each run's head_sha reads the other commit's runs, which are newer and green.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const ITEMS = ['ci', 'budgets', 'postgres-redis', 'mutation', 'adapters', 'soak']

type Fixture = {
  sha: string
  runs: { total_count: number; workflow_runs: Run[] }
  jobs: Record<string, Job[]>
  artifacts: Record<string, Record<string, Record<string, unknown>>>
}

const recorded = (): Fixture =>
  JSON.parse(
    readFileSync(join(REPO, 'tests/tooling/fixtures/release-check/green.json'), 'utf8'),
  ) as Fixture

const flag = (args: string[], name: string): string => args[args.indexOf(name) + 1]!

function fakeGh(f: Fixture): Gh {
  return (args) => {
    const [noun, verb] = args
    if (noun === 'api' && args.includes('repos/{owner}/{repo}/actions/runs')) {
      return JSON.stringify(f.runs)
    }
    if (noun === 'run' && verb === 'view') {
      const jobs = f.jobs[args[2]!]
      if (jobs === undefined) throw new Error(`gh: run ${args[2]} not found`)
      return JSON.stringify({ jobs })
    }
    if (noun === 'run' && verb === 'download') {
      const files = f.artifacts[args[2]!]?.[flag(args, '--name')]
      if (files === undefined) throw new Error('gh: no valid artifacts found to download')
      const dir = flag(args, '--dir')
      mkdirSync(dir, { recursive: true })
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), JSON.stringify(body))
      }
      return ''
    }
    throw new Error(`gh: unexpected call ${args.join(' ')}`)
  }
}

const ADAPTERS = (
  JSON.parse(readFileSync(join(REPO, 'registry/adapters.json'), 'utf8')) as {
    adapters: Array<{ package: string }>
  }
).adapters.map((a) => a.package)

type Overrides = { head?: string; target?: { code: number; output: string } }

function runCheck(f: Fixture, o: Overrides = {}) {
  const result = check({
    sha: f.sha,
    gh: fakeGh(f),
    head: () => o.head ?? f.sha,
    target: () =>
      o.target ?? { code: 0, output: 'mutation target: 70 files at or above their floor' },
    adapters: ADAPTERS,
  })
  const { text, code } = render(result)
  const verdicts = Object.fromEntries(result.items.map((i) => [i.item, i.verdict]))
  return { text, code, verdicts, items: result.items }
}

const runsOf = (f: Fixture, workflow: string): Run[] =>
  f.runs.workflow_runs.filter((r) => r.path === `.github/workflows/${workflow}`)
const candidateRun = (f: Fixture, workflow: string): Run =>
  runsOf(f, workflow).find((r) => r.head_sha === f.sha && r.event !== 'push')!
const jobsOf = (f: Fixture, workflow: string): Job[] =>
  f.jobs[String(candidateRun(f, workflow).id)]!
const jobNamed = (f: Fixture, workflow: string, name: string): Job =>
  jobsOf(f, workflow).find((j) => j.name === name)!

/** Every item ok except `red`, each of which has the verdict given. */
function expectOnly(verdicts: Record<string, string>, red: Record<string, string>): void {
  expect(verdicts).toEqual(Object.fromEntries(ITEMS.map((item) => [item, red[item] ?? 'ok'])))
}

describe('AC-4: release:check against recorded gh output', () => {
  it('AC-4: every item green at the candidate: ready, exit 0, each line naming the candidate’s run and never the newer one at another sha', () => {
    const f = recorded()
    const { text, code, verdicts, items } = runCheck(f)
    expect(code, text).toBe(0)
    expectOnly(verdicts, {})
    expect(text.trimEnd().split('\n').at(-1)).toBe('release-check: ready')
    const runUrls = new Set(items.flatMap((i) => i.urls))
    const atSha = new Set(
      f.runs.workflow_runs.filter((r) => r.head_sha === f.sha).map((r) => r.html_url),
    )
    expect([...runUrls].filter((u) => !atSha.has(u))).toEqual([])
    expect(items.every((i) => i.urls.length >= 1)).toBe(true)
  })

  const CASES: Array<{
    name: string
    act: (f: Fixture) => Overrides | void
    red: Record<string, string>
  }> = [
    {
      name: 'one red job in the nightly’s store matrix',
      act: (f) => {
        jobNamed(f, NIGHTLY, 'E2E — nextjs on postgres-jsonb').conclusion = 'failure'
      },
      red: { 'postgres-redis': 'red' },
    },
    {
      name: 'the dispatch at the candidate gone, a newer green one at another sha',
      act: (f) => {
        const gone = candidateRun(f, CI)
        f.runs.workflow_runs = f.runs.workflow_runs.filter((r) => r !== gone)
      },
      red: { ci: 'missing', budgets: 'red', 'postgres-redis': 'red' },
    },
    {
      name: 'the Lighthouse step skipped',
      act: (f) => {
        const step = jobNamed(f, CI, BUDGETS_JOB).steps!.find((s) => s.name === LIGHTHOUSE_STEP)!
        step.conclusion = 'skipped'
      },
      red: { budgets: 'red' },
    },
    {
      name: 'no nightly at the candidate',
      act: (f) => {
        const gone = candidateRun(f, NIGHTLY)
        f.runs.workflow_runs = f.runs.workflow_runs.filter((r) => r !== gone)
      },
      red: { budgets: 'red', 'postgres-redis': 'red', mutation: 'missing' },
    },
    {
      name: 'a registry entry failing',
      act: (f) => {
        const id = String(candidateRun(f, REGISTRY).id)
        const status = f.artifacts[id]![REGISTRY_ARTIFACT]!['status.json'] as {
          adapters: Array<{ history: { status: string } }>
        }
        status.adapters[3]!.history.status = 'failing'
      },
      red: { adapters: 'red' },
    },
    {
      name: 'a listed adapter missing from status.json',
      act: (f) => {
        const id = String(candidateRun(f, REGISTRY).id)
        const status = f.artifacts[id]![REGISTRY_ARTIFACT]!['status.json'] as {
          adapters: unknown[]
        }
        status.adapters.pop()
      },
      red: { adapters: 'red' },
    },
    {
      name: 'nineteen soak jobs, every one green',
      act: (f) => {
        const id = String(candidateRun(f, SOAK).id)
        f.jobs[id] = f.jobs[id]!.filter((j) => j.name !== `${SOAK_JOB_PREFIX}20 (nextjs)`)
      },
      red: { soak: 'red' },
    },
    {
      name: 'a checkout HEAD other than the candidate',
      act: () => ({ head: '0'.repeat(40) }),
      red: { mutation: 'red' },
    },
    {
      name: 'a file below its floor',
      act: () => ({
        target: {
          code: 1,
          output:
            'below target: packages/platform/src/services/x.ts 59.99 < 60 (services)\nmutation target: 1 file(s) below their floor',
        },
      }),
      red: { mutation: 'red' },
    },
  ]

  for (const c of CASES) {
    it(`AC-4: ${c.name}: that item alone is not ok, exit 1, and the count matches`, () => {
      const f = recorded()
      const overrides = c.act(f) ?? {}
      const { text, code, verdicts } = runCheck(f, overrides)
      expect(code, text).toBe(1)
      expectOnly(verdicts, c.red)
      const failing = Object.values(verdicts).filter((v) => v !== 'ok').length
      expect(text.trimEnd().split('\n').at(-1)).toBe(`release-check: not ready (${failing})`)
      for (const [item, verdict] of Object.entries(c.red)) {
        expect(text).toMatch(new RegExp(`^release-check: ${item} ${verdict} `, 'm'))
      }
    })
  }

  it('AC-4: a checkout at another commit is named, and the floors are not read from it', () => {
    const f = recorded()
    let read = 0
    const result = check({
      sha: f.sha,
      gh: fakeGh(f),
      head: () => 'b'.repeat(40),
      target: () => {
        read += 1
        return { code: 0, output: '' }
      },
      adapters: ADAPTERS,
    })
    const mutation = result.items.find((i) => i.item === 'mutation')!
    expect(mutation.what).toEqual([`checkout at ${'b'.repeat(40)}`])
    expect(read).toBe(0)
  })

  it('AC-4: red mobile and quarantine jobs leave the candidate ready and are printed', () => {
    const f = recorded()
    for (const name of NOTED_JOBS) jobNamed(f, NIGHTLY, name).conclusion = 'failure'
    const { text, code, verdicts } = runCheck(f)
    expect(code, text).toBe(0)
    expectOnly(verdicts, {})
    const noted = text
      .split('\n')
      .filter((l) => l.startsWith('release-check: noted, not counted: '))
    expect(noted).toEqual(NOTED_JOBS.map((n) => `release-check: noted, not counted: ${n}: failure`))
  })
})

// ---------------------------------------------------------------------------------------------------------------

type WfJob = {
  name?: string
  strategy?: { matrix?: Record<string, Yaml> }
  steps?: Array<{
    name?: string
    uses?: string
    with?: Record<string, Yaml>
    env?: Record<string, Yaml>
    run?: string
    id?: string
  }>
}
type Workflow = { on?: Record<string, Yaml>; jobs: Record<string, WfJob> }

const workflow = (file: string): Workflow =>
  parseYaml(readFileSync(join(REPO, '.github/workflows', file), 'utf8')) as unknown as Workflow

/** A job's names with its list matrix expanded; a matrix from an expression leaves the name as written. */
function jobNames(job: WfJob): string[] {
  const name = job.name ?? ''
  const matrix = job.strategy?.matrix ?? {}
  let names = [name]
  for (const [key, values] of Object.entries(matrix)) {
    if (!Array.isArray(values)) continue
    names = names.flatMap((n) =>
      values.map((v) => n.replaceAll(`\${{ matrix.${key} }}`, String(v))),
    )
  }
  return names
}

const allJobNames = (file: string): string[] => Object.values(workflow(file).jobs).flatMap(jobNames)

describe('AC-5: what release:check requires exists in its workflows', () => {
  it('AC-5: every job and step it reads is a job or step of its workflow, matrices expanded', () => {
    const ci = allJobNames(CI)
    const nightly = allJobNames(NIGHTLY)
    expect([BUDGETS_JOB, ...INTEGRATION_JOBS].filter((n) => !ci.includes(n))).toEqual([])
    expect(
      [BUDGETS_JOB, ...STORE_JOBS, ...MUTATION_JOBS, ...NOTED_JOBS].filter(
        (n) => !nightly.includes(n),
      ),
    ).toEqual([])
    const perf = Object.values(workflow(CI).jobs).find((j) => j.name === BUDGETS_JOB)!
    expect((perf.steps ?? []).map((s) => s.name)).toContain(LIGHTHOUSE_STEP)
    const upload = Object.values(workflow(REGISTRY).jobs)
      .flatMap((j) => j.steps ?? [])
      .filter((s) => s.uses?.startsWith('actions/upload-artifact@'))
      .map((s) => s.with?.['name'])
    expect(upload).toEqual([REGISTRY_ARTIFACT])
    const quickstart = allJobNames(SOAK).filter((n) => n.startsWith(SOAK_JOB_PREFIX))
    expect(quickstart).toHaveLength(1)
  })

  it('AC-5: the soak runs on a pull request into main, and with no input plans exactly the runs the check requires', () => {
    const soak = workflow(SOAK)
    expect(soak.on?.['pull_request']).toEqual({ branches: ['main'] })
    const plan = soak.jobs['plan']!.steps!.find((s) => s.id === 'matrix')!
    const runs = String(plan.env?.['RUNS'])
    const fallback = /^\$\{\{ inputs\.runs \|\| (\d+) \}\}$/.exec(runs)
    expect(fallback, runs).not.toBeNull()
    // The plan step's own script, given what the expression yields on a pull request.
    const script = /node -e '([\s\S]*)'/.exec(plan.run ?? '')![1]!
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, RUNS: fallback![1]! },
      encoding: 'utf8',
    })
    const matrix = JSON.parse(out.trim().replace(/^matrix=/, '')) as unknown[]
    expect(matrix).toHaveLength(SOAK_RUNS)
  })
})
