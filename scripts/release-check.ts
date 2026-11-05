import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// Whether a release candidate meets the release row, item by item, each from the GitHub runs at the candidate's sha
// and never from the newest run of another commit: a dispatched CI run green in every job, the performance budgets
// (the Lighthouse step included) in it and in the nightly, the Postgres and Redis runs, the mutation runs and the
// floors of mutation-targets.json, the adapter registry and the quickstart soak. It reads through `gh` and runs
// nothing on GitHub. Run it from a checkout at the candidate: `pnpm release:check --sha <sha>`.

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
export type Item = { item: string; verdict: Verdict; urls: string[]; what: string[] }

export type CheckOptions = {
  sha: string
  gh: Gh
  /** The checkout's HEAD. */
  head: () => string
  /** `mutation:ratchet target` in the checkout. */
  target: () => { code: number; output: string }
  /** The packages registry/adapters.json lists. */
  adapters: string[]
}

export const CI = 'ci.yml'
export const NIGHTLY = 'nightly.yml'
export const REGISTRY = 'registry.yml'
export const SOAK = 'quickstart-soak.yml'

export const BUDGETS_JOB = 'Performance budgets — both templates, five pages'
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

const item = (name: string, urls: string[], what: string[], missing = false): Item => ({
  item: name,
  verdict: missing ? 'missing' : what.length === 0 ? 'ok' : 'red',
  urls,
  what,
})

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
  const { sha, gh } = opts
  const dispatch = ['workflow_dispatch']
  const runs = listRuns(gh, sha)
  const ci = fetch(gh, runs, CI, sha, dispatch)
  const nightly = fetch(gh, runs, NIGHTLY, sha, dispatch)
  const items: Item[] = []
  const noRun = (workflow: string, events: string[]): string =>
    `no ${events.join(' or ')} run of ${workflow} at ${sha}`
  // The nightly's own conclusion is not read: its mobile and quarantine jobs may be red without holding a release.
  const runRed = (run: Run): string[] =>
    run.status === 'completed' && run.conclusion === 'success'
      ? []
      : [`run ${run.conclusion ?? run.status}`]

  // ci: the dispatched run, every job green.
  if (ci === undefined) items.push(item('ci', [], [noRun(CI, dispatch)], true))
  else {
    const red = ci.jobs
      .filter((j) => !green(j))
      .map((j) => `${j.name}: ${j.conclusion ?? j.status}`)
    items.push(item('ci', [ci.run.html_url], [...runRed(ci.run), ...red]))
  }

  // budgets: the budgets job of the dispatch with its Lighthouse step run and green, and the nightly's budgets job.
  {
    const what: string[] = []
    const urls: string[] = []
    if (ci === undefined) what.push(noRun(CI, dispatch))
    else {
      urls.push(ci.run.html_url)
      what.push(...notGreen(ci.jobs, [BUDGETS_JOB]))
      const step = ci.jobs
        .find((j) => j.name === BUDGETS_JOB)
        ?.steps?.find((s) => s.name === LIGHTHOUSE_STEP)
      if (step === undefined) what.push(`${LIGHTHOUSE_STEP}: no such step`)
      else if (step.conclusion !== 'success')
        what.push(`${LIGHTHOUSE_STEP}: ${step.conclusion ?? step.status}`)
    }
    if (nightly === undefined) what.push(noRun(NIGHTLY, dispatch))
    else {
      urls.push(nightly.run.html_url)
      what.push(...notGreen(nightly.jobs, [BUDGETS_JOB]).map((w) => `nightly ${w}`))
    }
    items.push(item('budgets', urls, what, ci === undefined && nightly === undefined))
  }

  // postgres-redis: the dispatch's integration jobs and the nightly's E2E on both store sets.
  {
    const what: string[] = []
    const urls: string[] = []
    if (ci === undefined) what.push(noRun(CI, dispatch))
    else {
      urls.push(ci.run.html_url)
      what.push(...notGreen(ci.jobs, INTEGRATION_JOBS))
    }
    if (nightly === undefined) what.push(noRun(NIGHTLY, dispatch))
    else {
      urls.push(nightly.run.html_url)
      what.push(...notGreen(nightly.jobs, STORE_JOBS))
    }
    items.push(item('postgres-redis', urls, what, ci === undefined && nightly === undefined))
  }

  // mutation: the nightly's two Stryker jobs, and the floors in this checkout, which must be the candidate.
  {
    const what: string[] = []
    const urls: string[] = []
    if (nightly === undefined) what.push(noRun(NIGHTLY, dispatch))
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
    items.push(item('mutation', urls, what, nightly === undefined))
  }

  // adapters: the registry run green, and every listed adapter in its status.json neither failing nor suspended.
  {
    const run = newestAt(runs, REGISTRY, sha, dispatch)
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

  // soak: at least SOAK_RUNS quickstart jobs, every one green, on the promotion pull request or a dispatch.
  {
    const events = ['pull_request', 'workflow_dispatch']
    const soak = fetch(gh, runs, SOAK, sha, events)
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

  const notes =
    nightly === undefined
      ? []
      : NOTED_JOBS.map((name) => {
          const job = nightly.jobs.find((j) => j.name === name)
          return `${name}: ${job === undefined ? 'no such job' : (job.conclusion ?? job.status)}`
        })
  return { items, notes }
}

export function render({ items, notes }: { items: Item[]; notes: string[] }): {
  text: string
  code: number
} {
  const lines = items.map((i) =>
    [
      `release-check: ${i.item} ${i.verdict}`,
      i.urls.length === 0 ? '(no run)' : i.urls.join(' '),
      ...(i.what.length === 0 ? [] : [`[${i.what.join('; ')}]`]),
    ].join(' '),
  )
  for (const note of notes) lines.push(`release-check: noted, not counted: ${note}`)
  const failed = items.filter((i) => i.verdict !== 'ok').length
  lines.push(failed === 0 ? 'release-check: ready' : `release-check: not ready (${failed})`)
  return { text: `${lines.join('\n')}\n`, code: failed === 0 ? 0 : 1 }
}

function main(argv: string[]): number {
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
  })
  const { text, code } = render(result)
  process.stdout.write(text)
  return code
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(
      `release-check: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 2
  }
}
