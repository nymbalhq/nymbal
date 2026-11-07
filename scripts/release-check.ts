import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_THRESHOLD } from '../packages/cli/src/commands/eval-stamp'
import { INTEGRATION_RATCHET, RATCHET } from './gate'
import { EXCLUDED_PREFIXES, TEST_FILE } from './test-census'

// Whether a release candidate meets the release row, item by item, each from the GitHub runs at the candidate's sha
// and never from the newest run of another commit: dev's push CI run green in every job, with every earlier commit's
// push run green or else a dispatch of every job at the candidate, the performance budgets in it, in a dispatched
// Lighthouse run and in the nightly, the Postgres and Redis runs, the mutation runs and the floors of
// mutation-targets.json, the adapter registry and the quickstart soak. The nightly and the Lighthouse dispatch may be
// carried from an earlier candidate of the same release when every commit since touches only tests (`testOnly`). It
// reads through `gh` and git and runs nothing on GitHub. Run it from a checkout at the candidate:
// `pnpm release:check --sha <sha>`.

/** A `gh` call: its arguments in, its stdout out; it throws when gh fails. */
export type Gh = (args: string[]) => string

/** A workflow run as the REST API gives it (`GET /repos/{owner}/{repo}/actions/runs`), the fields read here. */
export type Run = {
  id: number
  path: string
  head_sha: string
  event: string
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
}

export type Step = { name: string; status: string; conclusion: string | null }
export type Job = {
  name: string
  status: string
  conclusion: string | null
  url?: string
  steps?: Step[]
}

export type Verdict = 'ok' | 'red' | 'missing'
export type Item = {
  item: string
  verdict: Verdict
  urls: string[]
  what: string[]
  /** Runs read at an earlier candidate, as `<run> carried from <sha>: test-only <sha>..<candidate>`. */
  carried: string[]
}

/** A commit of the release and the files it changes over its first parent. */
export type Commit = { sha: string; files: string[] }

export type CheckOptions = {
  sha: string
  gh: Gh
  /** The checkout's HEAD. */
  head: () => string
  /** `mutation:ratchet target` in the checkout. */
  target: () => { code: number; output: string }
  /** The packages registry/adapters.json lists. */
  adapters: string[]
  /**
   * The release's commits along the first parent, the candidate first, back to the last release (`releaseHistory`):
   * the only commits a run may be carried from.
   */
  history: Commit[]
  /** `packages/platform/assistant-eval.json` as committed at `sha` (`stampAt`); undefined when it has none. */
  stamp: string | undefined
  /** How many golden questions the eval asks: a stamp records a run of every one. */
  questions: number
}

export const STAMP_FILE = 'packages/platform/assistant-eval.json'
export const STAMP_COMMAND = `nymbal eval assistant --runs 5 --stamp <absolute path to ${STAMP_FILE}>`

export const CI = 'ci.yml'
export const NIGHTLY = 'nightly.yml'
export const REGISTRY = 'registry.yml'
export const SOAK = 'quickstart-soak.yml'

export const BUDGETS_JOB = 'Performance budgets — both templates, five pages'
/** The nightly's run of every harness project, which a push runs only when a harness path changed. */
export const HARNESS_JOB = 'Gate — tests, the harness projects included'
export const LIGHTHOUSE_STEP = 'perf:budgets (tests/perf)'
export const INTEGRATION_JOBS = [
  'Integration — integration-postgres',
  'Integration — integration-stores',
]
const TARGETS = ['astro', 'nextjs', 'admin']
export const STORE_JOBS = ['postgres-redis', 'postgres-jsonb'].flatMap((stores) =>
  TARGETS.map((target) => `E2E — ${target} on ${stores}`),
)
export const MUTATION_JOBS = ['Mutation — full Stryker run', 'Mutation — integration-tested files']
export const REGISTRY_ARTIFACT = 'registry-site'
export const SOAK_JOB_PREFIX = 'Quickstart '
export const SOAK_RUNS = 20
/** Printed with their conclusion, never counted: the phone-width verdict is the release walk's. */
export const NOTED_JOBS = [...TARGETS.map((t) => `E2E — ${t}, mobile`), 'Quarantined tests']
/**
 * The run of every job at the candidate, each gate.ts selection diffed against the last release: what covers a commit
 * of the release whose own push run never finished green.
 */
export const FULL_DISPATCH =
  'gh workflow run ci.yml --ref dev -f select=all -f base=$(git rev-parse origin/main)'
/** The suites the carried runs themselves execute: a change to one is a change to what they measured. */
export const CARRIED_SUITES = ['tests/e2e/', 'tests/perf/']

/**
 * A path whose change leaves the nightly's and the Lighthouse dispatch's results standing: a test file or the test
 * material the census leaves out (sentinels, tooling fixtures), as test-census.ts classes them for the gate, or a
 * mutation ratchet; never one of the carried runs' own suites. Everything else (package source, the mutate sets,
 * templates, apps, configs, budgets, test helpers) is measured, and its change runs them again.
 */
export function testOnly(path: string): boolean {
  if (CARRIED_SUITES.some((prefix) => path.startsWith(prefix))) return false
  return (
    TEST_FILE.test(path) ||
    EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    path === RATCHET ||
    path === INTEGRATION_RATCHET
  )
}

/** The newest run of `workflow` at `sha` among `events`; runs at any other sha are never read. */
export function newestAt(
  runs: Run[],
  workflow: string,
  sha: string,
  events: string[],
): Run | undefined {
  return runs
    .filter(
      (r) =>
        r.path === `.github/workflows/${workflow}` &&
        r.head_sha === sha &&
        events.includes(r.event),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
}

/**
 * Every run at `sha`, from the REST API: `gh run list --workflow` refuses a workflow the default branch does not have
 * yet, which is the soak's case until the promotion that carries it merges.
 */
function listRuns(gh: Gh, sha: string): Run[] {
  const page = JSON.parse(
    gh([
      'api',
      '-X',
      'GET',
      'repos/{owner}/{repo}/actions/runs',
      '-f',
      `head_sha=${sha}`,
      '-f',
      'per_page=100',
    ]),
  ) as { workflow_runs?: Run[] }
  return page.workflow_runs ?? []
}

function listJobs(gh: Gh, run: Run): Job[] {
  return (JSON.parse(gh(['run', 'view', String(run.id), '--json', 'jobs'])) as { jobs: Job[] }).jobs
}

const green = (job: Job | undefined): boolean =>
  job !== undefined && job.status === 'completed' && job.conclusion === 'success'

/** The named jobs that are absent or not green, as `<name>: <conclusion>`. */
function notGreen(jobs: Job[], names: string[]): string[] {
  return names.flatMap((name) => {
    const job = jobs.find((j) => j.name === name)
    if (job === undefined) return [`${name}: no such job`]
    return green(job) ? [] : [`${name}: ${job.conclusion ?? job.status}`]
  })
}

type Fetched = { run: Run; jobs: Job[] } | undefined

function fetch(gh: Gh, runs: Run[], workflow: string, sha: string, events: string[]): Fetched {
  const run = newestAt(runs, workflow, sha, events)
  return run === undefined ? undefined : { run, jobs: listJobs(gh, run) }
}

const item = (
  name: string,
  urls: string[],
  what: string[],
  missing = false,
  carried: string[] = [],
): Item => ({
  item: name,
  verdict: missing ? 'missing' : what.length === 0 ? 'ok' : 'red',
  urls,
  what,
  carried,
})

const short = (sha: string): string => sha.slice(0, 12)

/** A run read for the candidate; `from` is the earlier candidate's sha when it was carried from there. */
type Source = { run: Run; jobs: Job[]; from?: string }

/** The registry run's status.json entries, by package. */
function registryStatus(gh: Gh, run: Run): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-release-check-'))
  try {
    gh(['run', 'download', String(run.id), '--name', REGISTRY_ARTIFACT, '--dir', dir])
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      adapters?: Array<{ package: string; history?: { status?: string } }>
    }
    return new Map((status.adapters ?? []).map((a) => [a.package, a.history?.status ?? 'none']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function check(opts: CheckOptions): { items: Item[]; notes: string[] } {
  const { sha, gh, history } = opts
  const dispatch = ['workflow_dispatch']
  const listed = new Map<string, Run[]>()
  const runsAt = (at: string): Run[] => {
    if (!listed.has(at)) listed.set(at, listRuns(gh, at))
    return listed.get(at)!
  }
  const noRun = (workflow: string, events: string[]): string =>
    `no ${events.join(' or ')} run of ${workflow} at ${sha}`
  // The nightly's own conclusion is not read: its mobile and quarantine jobs may be red without holding a release.
  const runRed = (run: Run): string[] =>
    run.status === 'completed' && run.conclusion === 'success'
      ? []
      : [`run ${run.conclusion ?? run.status}`]

  /**
   * The newest run of `workflow` at the candidate; with none, the nearest at an earlier commit of the release when
   * every commit since touches only test paths, and only when `red` finds nothing there (a red there is never passed
   * over for an older green). `why` says why nothing was carried.
   */
  const atOrCarried = (
    workflow: string,
    red: (found: Source) => string[],
  ): { found?: Source; why: string[] } => {
    const own = fetch(gh, runsAt(sha), workflow, sha, dispatch)
    if (own !== undefined) return { found: own, why: [] }
    if (history[0]?.sha !== sha)
      return { why: [`none carried: ${short(sha)} is not the release history's head`] }
    for (let k = 1; k < history.length; k += 1) {
      const since = history[k - 1]!
      const measured = since.files.filter((path) => !testOnly(path))
      if (measured.length > 0) {
        const named = measured.slice(0, 3).join(', ')
        const more = measured.length > 3 ? ` and ${measured.length - 3} more` : ''
        return { why: [`none carried past ${short(since.sha)}: ${named}${more} not test-only`] }
      }
      const earlier = history[k]!.sha
      const there = fetch(gh, runsAt(earlier), workflow, earlier, dispatch)
      if (there === undefined) continue
      const reds = red(there)
      if (reds.length > 0)
        return { why: [`not carried from ${short(earlier)}: ${reds.join('; ')}`] }
      return { found: { ...there, from: earlier }, why: [] }
    }
    return { why: ['none earlier in the release'] }
  }
  const carriedAs = (what: string, found: Source | undefined): string[] =>
    found?.from === undefined
      ? []
      : [`${what} carried from ${short(found.from)}: test-only ${short(found.from)}..${short(sha)}`]

  const lighthouseRed = (found: Source): string[] => {
    const step = found.jobs
      .find((j) => j.name === BUDGETS_JOB)
      ?.steps?.find((s) => s.name === LIGHTHOUSE_STEP)
    return [
      ...notGreen(found.jobs, [BUDGETS_JOB]),
      ...(step === undefined
        ? [`${LIGHTHOUSE_STEP}: no such step`]
        : step.conclusion === 'success'
          ? []
          : [`${LIGHTHOUSE_STEP}: ${step.conclusion ?? step.status}`]),
    ]
  }
  // What the release reads of the nightly, each job green, before it may be carried.
  const nightlyRed = (found: Source): string[] =>
    found.run.status === 'completed'
      ? notGreen(found.jobs, [HARNESS_JOB, BUDGETS_JOB, ...STORE_JOBS, ...MUTATION_JOBS])
      : [`run ${found.run.status}`]

  const push = fetch(gh, runsAt(sha), CI, sha, ['push'])
  // A push run tests only its own push's diff, so the candidate's says nothing of an earlier commit whose own run was
  // cancelled, went red or never ran: each one's latest attempt is read, and any not green asks for a dispatch of
  // every job at the candidate.
  const unchecked = history
    .filter((c) => c.sha !== sha)
    .flatMap(({ sha: at }): Array<{ going: boolean; says: string }> => {
      const run = newestAt(runsAt(at), CI, at, ['push'])
      if (run === undefined) return [{ going: false, says: `no push run of ${CI} at ${short(at)}` }]
      if (run.status !== 'completed')
        return [{ going: true, says: `push run at ${short(at)} ${run.status} ${run.html_url}` }]
      if (run.conclusion === 'success') return []
      return [{ going: false, says: `push run at ${short(at)} ${run.conclusion} ${run.html_url}` }]
    })
  const { found: lighthouse, why: lighthouseWhy } = atOrCarried(CI, lighthouseRed)
  const { found: nightly, why: nightlyWhy } = atOrCarried(NIGHTLY, nightlyRed)
  const noPush = noRun(CI, ['push'])
  const noNightly = [noRun(NIGHTLY, dispatch), ...nightlyWhy]
  const items: Item[] = []

  // ci: dev's push run at the candidate, every job green, the push run of every earlier commit of the release green or
  // a dispatch of every job green at the candidate, and the nightly's run of every harness project.
  {
    const what: string[] = []
    const urls: string[] = []
    if (push === undefined) what.push(noPush)
    else {
      urls.push(push.run.html_url)
      what.push(
        ...runRed(push.run),
        ...push.jobs.filter((j) => !green(j)).map((j) => `${j.name}: ${j.conclusion ?? j.status}`),
      )
    }
    if (unchecked.some((u) => u.going)) {
      what.push(...unchecked.map((u) => u.says), 'wait for it, then run release:check again')
    } else if (unchecked.length > 0) {
      const full = fetch(gh, runsAt(sha), CI, sha, dispatch)
      if (full !== undefined) urls.push(full.run.html_url)
      const reds =
        full === undefined
          ? [noRun(CI, dispatch)]
          : [
              ...runRed(full.run),
              ...full.jobs
                .filter((j) => !green(j))
                .map((j) => `${j.name}: ${j.conclusion ?? j.status}`),
            ]
      if (reds.length > 0)
        what.push(
          ...unchecked.map((u) => u.says),
          ...reds,
          `the release must run every job at the candidate: ${FULL_DISPATCH}`,
        )
    }
    if (nightly === undefined) what.push(...noNightly)
    else {
      urls.push(nightly.run.html_url)
      what.push(...notGreen(nightly.jobs, [HARNESS_JOB]).map((w) => `nightly ${w}`))
    }
    items.push(item('ci', urls, what, push === undefined, carriedAs('nightly', nightly)))
  }

  // budgets: the push run's budgets job (script bytes), the Lighthouse step of a dispatch, and the nightly's budgets.
  {
    const what: string[] = []
    const urls: string[] = []
    if (push === undefined) what.push(noPush)
    else {
      urls.push(push.run.html_url)
      what.push(...notGreen(push.jobs, [BUDGETS_JOB]))
    }
    if (lighthouse === undefined) what.push(noRun(CI, dispatch), ...lighthouseWhy)
    else {
      urls.push(lighthouse.run.html_url)
      what.push(...lighthouseRed(lighthouse))
    }
    if (nightly === undefined) what.push(...noNightly)
    else {
      urls.push(nightly.run.html_url)
      what.push(...notGreen(nightly.jobs, [BUDGETS_JOB]).map((w) => `nightly ${w}`))
    }
    const carried = [
      ...carriedAs('Lighthouse dispatch', lighthouse),
      ...carriedAs('nightly', nightly),
    ]
    items.push(
      item(
        'budgets',
        urls,
        what,
        push === undefined && lighthouse === undefined && nightly === undefined,
        carried,
      ),
    )
  }

  // postgres-redis: the push run's integration jobs and the nightly's E2E on both store sets.
  {
    const what: string[] = []
    const urls: string[] = []
    if (push === undefined) what.push(noPush)
    else {
      urls.push(push.run.html_url)
      what.push(...notGreen(push.jobs, INTEGRATION_JOBS))
    }
    if (nightly === undefined) what.push(...noNightly)
    else {
      urls.push(nightly.run.html_url)
      what.push(...notGreen(nightly.jobs, STORE_JOBS))
    }
    items.push(
      item(
        'postgres-redis',
        urls,
        what,
        push === undefined && nightly === undefined,
        carriedAs('nightly', nightly),
      ),
    )
  }

  // mutation: the nightly's two Stryker jobs, and the floors in this checkout, which must be the candidate.
  {
    const what: string[] = []
    const urls: string[] = []
    if (nightly === undefined) what.push(...noNightly)
    else {
      urls.push(nightly.run.html_url)
      what.push(...notGreen(nightly.jobs, MUTATION_JOBS))
    }
    const head = opts.head()
    if (head !== sha) what.push(`checkout at ${head}`)
    else {
      const target = opts.target()
      if (target.code !== 0) {
        const lines = target.output
          .split('\n')
          .filter((l) => l.startsWith('below target: ') || l.startsWith('target: '))
        what.push(`mutation:ratchet target exit ${target.code}`, ...lines)
      }
    }
    items.push(item('mutation', urls, what, nightly === undefined, carriedAs('nightly', nightly)))
  }

  // adapters: the registry run green, and every listed adapter in its status.json neither failing nor suspended.
  {
    const run = newestAt(runsAt(sha), REGISTRY, sha, dispatch)
    if (run === undefined) items.push(item('adapters', [], [noRun(REGISTRY, dispatch)], true))
    else {
      const what = runRed(run)
      const status = registryStatus(gh, run)
      for (const pkg of opts.adapters) {
        const s = status.get(pkg)
        if (s === undefined) what.push(`${pkg}: not in status.json`)
        else if (s === 'failing' || s === 'suspended' || s === 'none') what.push(`${pkg}: ${s}`)
      }
      items.push(item('adapters', [run.html_url], what))
    }
  }

  // soak: at least SOAK_RUNS quickstart jobs, every one green, on the promotion pull request or a dispatch. Never
  // carried: it runs on the pull request's head.
  {
    const events = ['pull_request', 'workflow_dispatch']
    const soak = fetch(gh, runsAt(sha), SOAK, sha, events)
    if (soak === undefined) items.push(item('soak', [], [noRun(SOAK, events)], true))
    else {
      const quickstarts = soak.jobs.filter((j) => j.name.startsWith(SOAK_JOB_PREFIX))
      const what = [
        ...runRed(soak.run),
        ...(quickstarts.length >= SOAK_RUNS
          ? []
          : [`${quickstarts.length} quickstart jobs, fewer than ${SOAK_RUNS}`]),
        ...quickstarts
          .filter((j) => !green(j))
          .map((j) => `${j.name}: ${j.conclusion ?? j.status}`),
      ]
      items.push(item('soak', [soak.run.html_url], what))
    }
  }

  // assistant-eval: the stamp records a real provider's run that passed. The platform's unit test holds its hash to the
  // prompt and tools; a pending stamp passes that test and is held here instead.
  {
    const read = readStamp(opts.stamp)
    const stamp = read.stamp ?? {}
    const pending =
      opts.stamp === undefined
        ? `no ${STAMP_FILE} at ${short(sha)}`
        : read.error === undefined &&
            (typeof stamp.provider !== 'string' || stamp.provider === 'pending')
          ? `no real eval run recorded for this prompt: run \`${STAMP_COMMAND}\` against a real provider as CONTRIBUTING.md shows and commit the stamp`
          : undefined
    const what =
      pending !== undefined
        ? [pending]
        : read.error !== undefined
          ? [`${STAMP_FILE} at ${short(sha)} is not a stamp: ${read.error}`]
          : [
              ...(typeof stamp.threshold === 'number' && stamp.threshold >= DEFAULT_THRESHOLD
                ? []
                : [
                    `the stamp's threshold ${String(stamp.threshold)} is under the default ${DEFAULT_THRESHOLD}`,
                  ]),
              ...(stamp.total === opts.questions
                ? []
                : [
                    `the stamp's run asked ${String(stamp.total)} questions, not the ${opts.questions} the eval asks`,
                  ]),
              ...(typeof stamp.passed === 'number' &&
              typeof stamp.threshold === 'number' &&
              stamp.passed >= stamp.threshold
                ? []
                : [
                    `the stamp's run passed ${String(stamp.passed)}, under its threshold ${String(stamp.threshold)}`,
                  ]),
            ]
    items.push(item('assistant-eval', [STAMP_FILE], what, pending !== undefined))
  }

  const notes =
    nightly === undefined
      ? []
      : NOTED_JOBS.map((name) => {
          const job = nightly.jobs.find((j) => j.name === name)
          return `${name}: ${job === undefined ? 'no such job' : (job.conclusion ?? job.status)}${
            nightly.from === undefined ? '' : ` (nightly carried from ${short(nightly.from)})`
          }`
        })
  return { items, notes }
}

/** A stamp's fields, or why its text is not one. */
function readStamp(text: string | undefined): {
  stamp?: { provider?: unknown; passed?: unknown; threshold?: unknown; total?: unknown }
  error?: string
} {
  if (text === undefined) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'not a JSON object' }
  }
  return { stamp: value }
}

/** `STAMP_FILE` as committed at `sha`, never the working tree's; undefined when the commit has none. */
export function stampAt(root: string, sha: string): string | undefined {
  const git = (args: string[]) => {
    const out = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr.trim()}`)
    return out.stdout
  }
  if (git(['ls-tree', '--name-only', sha, '--', STAMP_FILE]).trim() === '') return undefined
  return git(['show', `${sha}:${STAMP_FILE}`])
}

/**
 * The release's commits from `sha` back along the first parent, newest first, stopping at `base` (the last release:
 * origin/main), each with the files it changes over its first parent: a back-merge of main lists the release files it
 * brings.
 */
export function releaseHistory(root: string, sha: string, base: string): Commit[] {
  const out = spawnSync(
    'git',
    [
      'log',
      '--first-parent',
      '--diff-merges=first-parent',
      '--name-only',
      '--format=%x01%H',
      sha,
      `^${base}`,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (out.status !== 0) throw new Error(`git log ${sha} ^${base}: ${out.stderr.trim()}`)
  return out.stdout
    .split('\u0001')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const [commit = '', ...files] = block.split('\n').filter((l) => l.trim() !== '')
      return { sha: commit.trim(), files }
    })
}

export function render({ items, notes }: { items: Item[]; notes: string[] }): {
  text: string
  code: number
} {
  const lines = items.map((i) =>
    [
      `release-check: ${i.item} ${i.verdict}`,
      ...(i.carried.length === 0 ? [] : [`(${i.carried.join('; ')})`]),
      i.urls.length === 0 ? '(no run)' : i.urls.join(' '),
      ...(i.what.length === 0 ? [] : [`[${i.what.join('; ')}]`]),
    ].join(' '),
  )
  for (const note of notes) lines.push(`release-check: noted, not counted: ${note}`)
  const failed = items.filter((i) => i.verdict !== 'ok').length
  lines.push(failed === 0 ? 'release-check: ready' : `release-check: not ready (${failed})`)
  return { text: `${lines.join('\n')}\n`, code: failed === 0 ? 0 : 1 }
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { sha: { type: 'string' } } })
  const root = process.cwd()
  const run = (cmd: string, args: string[]): { code: number; out: string; err: string } => {
    const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.error !== undefined) throw new Error(`${cmd}: ${r.error.message}`)
    return { code: r.status ?? 1, out: r.stdout, err: r.stderr }
  }
  const head = run('git', ['rev-parse', 'HEAD']).out.trim()
  const sha = values.sha ?? ''
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `usage: release-check.ts --sha <the candidate's full 40-character sha> (HEAD is ${head})`,
    )
  }
  const gh: Gh = (args) => {
    const r = run('gh', args)
    if (r.code !== 0) throw new Error(`gh ${args.join(' ')}: ${r.err.trim()}`)
    return r.out
  }
  const manifest = JSON.parse(readFileSync(resolve(root, 'registry/adapters.json'), 'utf8')) as {
    adapters: Array<{ package: string }>
  }
  const result = check({
    sha,
    gh,
    head: () => head,
    target: () => {
      const r = run(join(root, 'node_modules/.bin/tsx'), ['scripts/mutation-ratchet.ts', 'target'])
      return { code: r.code, output: `${r.out}${r.err}` }
    },
    adapters: manifest.adapters.map((a) => a.package),
    history: releaseHistory(root, sha, 'origin/main'),
    stamp: stampAt(root, sha),
    // The checkout's golden set: the mutation item holds the checkout to the candidate.
    questions: (await import('../packages/platform/src/assistant/golden.js')).GOLDEN_QUESTIONS.length,
  })
  const { text, code } = render(result)
  process.stdout.write(text)
  return code
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(
        `release-check: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 2
    },
  )
}
