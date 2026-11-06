// Reads: scripts/release-check.ts, .github/workflows/ci.yml, .github/workflows/nightly.yml, .github/workflows/registry.yml, .github/workflows/quickstart-soak.yml, registry/adapters.json, tests/tooling/fixtures/release-check/*.json
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUDGETS_JOB,
  CI,
  type Commit,
  check,
  FULL_DISPATCH,
  HARNESS_JOB,
  INTEGRATION_JOBS,
  LIGHTHOUSE_STEP,
  MUTATION_JOBS,
  NIGHTLY,
  NOTED_JOBS,
  REGISTRY,
  REGISTRY_ARTIFACT,
  releaseHistory,
  render,
  SOAK,
  SOAK_JOB_PREFIX,
  SOAK_RUNS,
  STORE_JOBS,
  type Gh,
  type Job,
  type Run,
} from '../../scripts/release-check'
import { cleanupScratch, git, scratchRepo, write } from './scratch-gate'
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

type Overrides = {
  head?: string
  target?: { code: number; output: string }
  history?: Commit[]
}

/** The candidate's own commit, a product change, and nothing earlier: no run can be carried to it. */
const ALONE = (f: Fixture): Commit[] => [
  { sha: f.sha, files: ['packages/platform/src/services/cart-service.ts'] },
]

function runCheck(f: Fixture, o: Overrides = {}) {
  const result = check({
    sha: f.sha,
    gh: fakeGh(f),
    head: () => o.head ?? f.sha,
    target: () =>
      o.target ?? { code: 0, output: 'mutation target: 70 files at or above their floor' },
    adapters: ADAPTERS,
    history: o.history ?? ALONE(f),
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
const pushRun = (f: Fixture): Run =>
  runsOf(f, CI).find((r) => r.head_sha === f.sha && r.event === 'push')!
const pushJobs = (f: Fixture): Job[] => f.jobs[String(pushRun(f).id)]!

/** Every item ok except `red`, each of which has the verdict given. */
function expectOnly(verdicts: Record<string, string>, red: Record<string, string>): void {
  expect(verdicts).toEqual(Object.fromEntries(ITEMS.map((item) => [item, red[item] ?? 'ok'])))
}

describe('AC-4: release:check against recorded gh output', () => {
  it('AC-4: every item green at the candidate, CI read from its push run and Lighthouse from a dispatch that ran nothing else: ready, exit 0, each line naming the candidate’s run and never the newer one at another sha', () => {
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
      name: 'the Lighthouse dispatch at the candidate gone, a newer green one at another sha',
      act: (f) => {
        const gone = candidateRun(f, CI)
        f.runs.workflow_runs = f.runs.workflow_runs.filter((r) => r !== gone)
      },
      red: { budgets: 'red' },
    },
    {
      name: 'the push run at the candidate gone, a newer green one at another sha',
      act: (f) => {
        const gone = pushRun(f)
        f.runs.workflow_runs = f.runs.workflow_runs.filter((r) => r !== gone)
      },
      red: { ci: 'missing', budgets: 'red', 'postgres-redis': 'red' },
    },
    {
      name: 'a red job in the push run while a dispatch of every job is green',
      act: (f) => {
        const dispatch = String(candidateRun(f, CI).id)
        f.jobs[dispatch] = structuredClone(pushJobs(f))
        for (const step of f.jobs[dispatch]!.find((j) => j.name === BUDGETS_JOB)!.steps!) {
          step.conclusion = 'success'
        }
        pushJobs(f).find((j) => j.name === 'E2E — Admin')!.conclusion = 'failure'
      },
      red: { ci: 'red' },
    },
    {
      name: 'the nightly’s harness job red',
      act: (f) => {
        jobNamed(f, NIGHTLY, HARNESS_JOB).conclusion = 'failure'
      },
      red: { ci: 'red' },
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
      red: { ci: 'red', budgets: 'red', 'postgres-redis': 'red', mutation: 'missing' },
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
      history: ALONE(f),
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

// A candidate that moved by commits touching only tests keeps the earlier candidate's nightly and Lighthouse dispatch,
// so neither runs again; the push run, the registry and the soak are always the candidate's own.

const EARLIER = recorded().sha
const LATER = 'd312531a'.repeat(5)
const short = (sha: string): string => sha.slice(0, 12)
const carried = (what: string): string =>
  `${what} carried from ${short(EARLIER)}: test-only ${short(EARLIER)}..${short(LATER)}`

/** The earlier candidate's `event` run of `workflow` run again at `sha`, with the same jobs and artifacts. */
function rerunAt(f: Fixture, workflow: string, event: string, sha: string, id: number): Run {
  const earlier = runsOf(f, workflow).find((r) => r.head_sha === EARLIER && r.event === event)!
  const run = {
    ...earlier,
    id,
    head_sha: sha,
    html_url: earlier.html_url.replace(String(earlier.id), String(id)),
    created_at: '2026-11-06T01:00:00Z',
  }
  f.runs.workflow_runs.unshift(run)
  f.jobs[String(id)] = structuredClone(f.jobs[String(earlier.id)]!)
  const artifacts = f.artifacts[String(earlier.id)]
  if (artifacts !== undefined) f.artifacts[String(id)] = structuredClone(artifacts)
  return run
}

/**
 * The release moved from EARLIER to LATER through commits touching `moves`, newest first (the first is LATER's own):
 * LATER has its push run, registry run and soak; only EARLIER has the nightly and the Lighthouse dispatch.
 */
function moved(moves: string[][]): { f: Fixture; history: Commit[]; shas: string[] } {
  const f = recorded()
  rerunAt(f, CI, 'push', LATER, 43000000100)
  rerunAt(f, REGISTRY, 'workflow_dispatch', LATER, 43000000301)
  rerunAt(f, SOAK, 'pull_request', LATER, 43000000401)
  f.sha = LATER
  const shas = moves.map((_, i) => (i === 0 ? LATER : `${'e'.repeat(39)}${i}`))
  const history = [
    ...moves.map((files, i) => ({ sha: shas[i]!, files })),
    { sha: EARLIER, files: ['packages/platform/src/services/proposal-preview.ts'] },
  ]
  return { f, history, shas }
}

const urlAt = (f: Fixture, workflow: string, event: string, sha: string): string =>
  runsOf(f, workflow).find((r) => r.head_sha === sha && r.event === event)!.html_url
const lineOf = (text: string, item: string): string | undefined =>
  text.split('\n').find((l) => l.startsWith(`release-check: ${item} `))
const NOTHING_CARRIED = {
  ci: 'red',
  budgets: 'red',
  'postgres-redis': 'red',
  mutation: 'missing',
}

describe('release:check carries the nightly and the Lighthouse dispatch across a test-only move', () => {
  it('unit tests, a sentinel and the ratchet since the earlier candidate: ready, each carried line naming both shas and the earlier run, the rest read at the candidate', () => {
    const { f, history, shas } = moved([
      ['packages/platform/src/services/proposal-preview.test.ts', 'mutation-ratchet.json'],
      ['tests/sentinels/I130-proposal-preview-total.patch', 'tests/tooling/release-check.test.ts'],
    ])
    rerunAt(f, CI, 'push', shas[1]!, 43000000101)
    const { text, code, verdicts, items } = runCheck(f, { history })
    expect(code, text).toBe(0)
    expectOnly(verdicts, {})
    const push = urlAt(f, CI, 'push', LATER)
    const lighthouse = urlAt(f, CI, 'workflow_dispatch', EARLIER)
    const nightly = urlAt(f, NIGHTLY, 'workflow_dispatch', EARLIER)
    expect(lineOf(text, 'ci')).toBe(
      `release-check: ci ok (${carried('nightly')}) ${push} ${nightly}`,
    )
    expect(lineOf(text, 'budgets')).toBe(
      `release-check: budgets ok (${carried('Lighthouse dispatch')}; ${carried('nightly')}) ${push} ${lighthouse} ${nightly}`,
    )
    expect(lineOf(text, 'postgres-redis')).toBe(
      `release-check: postgres-redis ok (${carried('nightly')}) ${push} ${nightly}`,
    )
    expect(lineOf(text, 'mutation')).toBe(
      `release-check: mutation ok (${carried('nightly')}) ${nightly}`,
    )
    const shaOf = (url: string): string =>
      f.runs.workflow_runs.find((r) => r.html_url === url)!.head_sha
    for (const item of ['adapters', 'soak']) {
      expect(items.find((i) => i.item === item)!.urls.map(shaOf)).toEqual([LATER])
    }
  })

  const NOT_CARRIED: Array<{ name: string; moves: string[][]; stop: number; file: string }> = [
    {
      name: 'a service beside its test',
      moves: [
        [
          'packages/platform/src/services/proposal-preview.test.ts',
          'packages/platform/src/services/proposal-preview.ts',
        ],
      ],
      stop: 0,
      file: 'packages/platform/src/services/proposal-preview.ts',
    },
    {
      name: 'a template page in the older of two commits',
      moves: [['packages/sdk/src/cart.test.ts'], ['templates/astro/src/pages/index.astro']],
      stop: 1,
      file: 'templates/astro/src/pages/index.astro',
    },
    {
      name: 'an admin page',
      moves: [['apps/admin/src/pages/OrdersPage.tsx']],
      stop: 0,
      file: 'apps/admin/src/pages/OrdersPage.tsx',
    },
    {
      name: 'an E2E journey, which the nightly itself runs',
      moves: [['tests/e2e/journeys/checkout.spec.ts']],
      stop: 0,
      file: 'tests/e2e/journeys/checkout.spec.ts',
    },
    {
      name: 'the Lighthouse suite',
      moves: [['tests/perf/perf-budgets.test.ts']],
      stop: 0,
      file: 'tests/perf/perf-budgets.test.ts',
    },
    {
      name: 'a test helper that is not a test file',
      moves: [['packages/platform/src/tests/fixtures.ts']],
      stop: 0,
      file: 'packages/platform/src/tests/fixtures.ts',
    },
  ]

  for (const c of NOT_CARRIED) {
    it(`${c.name} since the earlier candidate: nothing is carried, and the commit and file are named`, () => {
      const { f, history, shas } = moved(c.moves)
      const { text, code, verdicts, items } = runCheck(f, { history })
      expect(code, text).toBe(1)
      expectOnly(verdicts, NOTHING_CARRIED)
      expect(text).not.toContain('carried from')
      expect(lineOf(text, 'mutation')).toContain(
        `none carried past ${short(shas[c.stop]!)}: ${c.file} not test-only`,
      )
      const earlier = new Set(
        f.runs.workflow_runs.filter((r) => r.head_sha === EARLIER).map((r) => r.html_url),
      )
      expect(items.flatMap((i) => i.urls).filter((u) => earlier.has(u))).toEqual([])
    })
  }

  it('the nearest earlier nightly red: nothing is carried past it to the green one further back', () => {
    const { f, history, shas } = moved([
      ['packages/sdk/src/cart.test.ts'],
      ['packages/sdk/src/auth.test.ts'],
    ])
    const between = shas[1]!
    const red = rerunAt(f, NIGHTLY, 'workflow_dispatch', between, 43000000201)
    f.jobs[String(red.id)]!.find((j) => j.name === 'E2E — nextjs on postgres-jsonb')!.conclusion =
      'failure'
    const { text, code, verdicts } = runCheck(f, { history })
    expect(code, text).toBe(1)
    expectOnly(verdicts, NOTHING_CARRIED)
    expect(lineOf(text, 'postgres-redis')).toContain(
      `not carried from ${short(between)}: E2E — nextjs on postgres-jsonb: failure`,
    )
    expect(text).not.toContain(urlAt(f, NIGHTLY, 'workflow_dispatch', EARLIER))
  })

  it('an earlier candidate outside the release history is never read', () => {
    const { f } = moved([['packages/sdk/src/cart.test.ts']])
    const { text, code, verdicts } = runCheck(f, {
      history: [{ sha: LATER, files: ['packages/sdk/src/cart.test.ts'] }],
    })
    expect(code, text).toBe(1)
    expectOnly(verdicts, NOTHING_CARRIED)
    expect(lineOf(text, 'mutation')).toContain('none earlier in the release')
  })

  it('the candidate’s own nightly is read, red, over a green one at the earlier candidate, while its missing Lighthouse dispatch is carried', () => {
    const { f, history } = moved([['packages/sdk/src/cart.test.ts']])
    const own = rerunAt(f, NIGHTLY, 'workflow_dispatch', LATER, 43000000202)
    f.jobs[String(own.id)]!.find((j) => j.name === 'E2E — astro on postgres-redis')!.conclusion =
      'failure'
    const { text, code, verdicts } = runCheck(f, { history })
    expect(code, text).toBe(1)
    expectOnly(verdicts, { 'postgres-redis': 'red' })
    const push = urlAt(f, CI, 'push', LATER)
    expect(lineOf(text, 'budgets')).toBe(
      `release-check: budgets ok (${carried('Lighthouse dispatch')}) ${push} ${urlAt(f, CI, 'workflow_dispatch', EARLIER)} ${own.html_url}`,
    )
    expect(lineOf(text, 'mutation')).toBe(`release-check: mutation ok ${own.html_url}`)
  })

  it('the push run and the soak are never carried: gone at the candidate, they are missing though the earlier candidate had both', () => {
    const { f, history } = moved([['packages/sdk/src/cart.test.ts']])
    f.runs.workflow_runs = f.runs.workflow_runs.filter(
      (r) => !(r.head_sha === LATER && (r.path.endsWith(CI) || r.path.endsWith(SOAK))),
    )
    const { text, code, verdicts } = runCheck(f, { history })
    expect(code, text).toBe(1)
    expectOnly(verdicts, {
      ci: 'missing',
      budgets: 'red',
      'postgres-redis': 'red',
      soak: 'missing',
    })
    expect(lineOf(text, 'mutation')).toBe(
      `release-check: mutation ok (${carried('nightly')}) ${urlAt(f, NIGHTLY, 'workflow_dispatch', EARLIER)}`,
    )
  })
})

// A push run tests only its own push's diff, so the candidate's run vouches for no earlier merge: one whose own push
// run was cancelled, red or never ran is covered only by a dispatch of every job at the candidate.

describe('release:check reads the push run of every commit in the release', () => {
  const twoMoves = () =>
    moved([['packages/sdk/src/cart.test.ts'], ['packages/sdk/src/auth.test.ts']])

  /** A run of every job at the candidate, green, its perf job with the Lighthouse step run. */
  function fullDispatchAt(f: Fixture, sha: string, id: number): Run {
    const run = rerunAt(f, CI, 'push', sha, id)
    run.event = 'workflow_dispatch'
    run.created_at = '2026-11-06T02:00:00Z'
    for (const step of f.jobs[String(id)]!.find((j) => j.name === BUDGETS_JOB)!.steps!) {
      step.conclusion = 'success'
    }
    return run
  }

  const UNCHECKED: Array<{
    name: string
    act: (f: Fixture, at: string) => void
    says: (f: Fixture, at: string) => string
  }> = [
    {
      name: 'cancelled',
      act: (f, at) => {
        rerunAt(f, CI, 'push', at, 43000000102).conclusion = 'cancelled'
      },
      says: (f, at) => `push run at ${short(at)} cancelled ${urlAt(f, CI, 'push', at)}`,
    },
    {
      name: 'red',
      act: (f, at) => {
        rerunAt(f, CI, 'push', at, 43000000102).conclusion = 'failure'
      },
      says: (f, at) => `push run at ${short(at)} failure ${urlAt(f, CI, 'push', at)}`,
    },
    {
      name: 'missing',
      act: () => {},
      says: (_f, at) => `no push run of ${CI} at ${short(at)}`,
    },
  ]

  for (const c of UNCHECKED) {
    it(`an earlier commit’s push run ${c.name}, the candidate’s green, no dispatch of every job: ci red, naming the commit, its run and the dispatch to make`, () => {
      const { f, history, shas } = twoMoves()
      c.act(f, shas[1]!)
      const { text, code, verdicts } = runCheck(f, { history })
      expect(code, text).toBe(1)
      expectOnly(verdicts, { ci: 'red' })
      const line = lineOf(text, 'ci')!
      expect(line).toContain(c.says(f, shas[1]!))
      expect(line).toContain(FULL_DISPATCH)
    })
  }

  it('an earlier commit’s push run cancelled and only the Lighthouse dispatch at the candidate: ci red, naming the jobs it skipped', () => {
    const { f, history, shas } = twoMoves()
    rerunAt(f, CI, 'push', shas[1]!, 43000000102).conclusion = 'cancelled'
    const lighthouse = rerunAt(f, CI, 'workflow_dispatch', LATER, 43000000103)
    const { text, code, verdicts } = runCheck(f, { history })
    expect(code, text).toBe(1)
    expectOnly(verdicts, { ci: 'red' })
    const line = lineOf(text, 'ci')!
    expect(line).toContain(lighthouse.html_url)
    expect(line).toContain('Gate — tests (shard 1 of 3): skipped')
    expect(line).toContain(FULL_DISPATCH)
  })

  it('an earlier commit’s push run cancelled and a dispatch of every job green at the candidate: ready, the ci line naming that dispatch', () => {
    const { f, history, shas } = twoMoves()
    rerunAt(f, CI, 'push', shas[1]!, 43000000102).conclusion = 'cancelled'
    const full = fullDispatchAt(f, LATER, 43000000103)
    const { text, code, verdicts } = runCheck(f, { history })
    expect(code, text).toBe(0)
    expectOnly(verdicts, {})
    expect(lineOf(text, 'ci')).toBe(
      `release-check: ci ok (${carried('nightly')}) ${urlAt(f, CI, 'push', LATER)} ${full.html_url} ${urlAt(f, NIGHTLY, 'workflow_dispatch', EARLIER)}`,
    )
  })

  it('an earlier commit’s push run still going: not ready, wait, though a dispatch of every job is green at the candidate', () => {
    const { f, history, shas } = twoMoves()
    const going = rerunAt(f, CI, 'push', shas[1]!, 43000000102)
    going.status = 'in_progress'
    going.conclusion = null
    fullDispatchAt(f, LATER, 43000000103)
    const { text, code, verdicts } = runCheck(f, { history })
    expect(code, text).toBe(1)
    expectOnly(verdicts, { ci: 'red' })
    const line = lineOf(text, 'ci')!
    expect(line).toContain(`push run at ${short(shas[1]!)} in_progress ${going.html_url}`)
    expect(line).toContain('wait for it')
    expect(line).not.toContain(FULL_DISPATCH)
  })
})

describe('the release history release:check walks', () => {
  afterEach(cleanupScratch)

  it('the commits since the last release, newest first along the first parent, each with the files it changes over that parent, a back-merge of main included', () => {
    const { root } = scratchRepo({ 'packages/a/src/a.ts': 'export const a = 1\n' })
    const commit = (path: string, body: string): string => {
      write(root, path, body)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', path)
      return git(root, 'rev-parse', 'HEAD')
    }
    git(root, 'branch', 'main')
    const test = commit('packages/a/src/a.test.ts', 'test\n')
    git(root, 'checkout', '-q', 'main')
    const version = commit('packages/a/package.json', '{"version":"1.1.0"}\n')
    git(root, 'checkout', '-q', 'dev')
    git(root, 'merge', '-q', '--no-ff', '-m', 'back-merge', 'main')
    const backMerge = git(root, 'rev-parse', 'HEAD')
    const sentinel = commit('tests/sentinels/I1-a.patch', 'patch\n')
    expect(releaseHistory(root, sentinel, version)).toEqual([
      { sha: sentinel, files: ['tests/sentinels/I1-a.patch'] },
      { sha: backMerge, files: ['packages/a/package.json'] },
      { sha: test, files: ['packages/a/src/a.test.ts'] },
    ])
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
      [BUDGETS_JOB, ...STORE_JOBS, ...MUTATION_JOBS, HARNESS_JOB, ...NOTED_JOBS].filter(
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
