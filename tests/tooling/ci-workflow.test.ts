import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type PlanInput, plan } from '../../scripts/gate'

// Acceptance tests for P0-03 part 2, AC-4: every pull-request job except `build` downloads the one artefact `build`
// uploads, and none of them runs `pnpm build` (directly, or through a gate.ts plan that would).
// No YAML library is a dependency of the repo, so the workflow is read by the small block-YAML reader below. It
// throws on anything outside the subset GitHub workflows here use, and the job list it returns is checked against
// the job keys found textually, so a misread fails loudly instead of passing quietly.

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url))
const NIGHTLY = fileURLToPath(new URL('../../.github/workflows/nightly.yml', import.meta.url))

type Yaml = string | null | Yaml[] | { [key: string]: Yaml }

function parseYaml(source: string): Yaml {
  const raw = source.split('\n').map((line) => line.replace(/\r$/, ''))
  let i = 0

  const blank = (line: string): boolean => /^\s*(?:#.*)?$/.test(line)
  const indentOf = (line: string): number => {
    const lead = /^[ \t]*/.exec(line)![0]
    if (lead.includes('\t')) throw new Error(`line ${i + 1}: tab in indentation`)
    return lead.length
  }
  const isSeqItem = (text: string): boolean => /^-(?: |$)/.test(text)
  const MAP_ENTRY = /^("[^"]*"|'[^']*'|[^\s"'#\-[{][^:]*?):(?: +(.*))?$/

  function skipBlank(): void {
    while (i < raw.length && blank(raw[i]!)) i += 1
  }

  function stripComment(value: string): string {
    const v = value.trim()
    if (v.startsWith('"') || v.startsWith("'")) {
      const quote = v[0]!
      let j = 1
      while (j < v.length) {
        if (v[j] === quote) {
          if (quote === "'" && v[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        if (quote === '"' && v[j] === '\\') j += 1
        j += 1
      }
      return v.slice(0, j + 1)
    }
    const hash = v.search(/\s#/)
    return (hash === -1 ? v : v.slice(0, hash)).trim()
  }

  function scalar(value: string): Yaml {
    const v = stripComment(value)
    if (/^[&*!%{@`]/.test(v) || /^[|>]/.test(v)) {
      throw new Error(`line ${i}: unsupported YAML construct: ${v}`)
    }
    if (v.startsWith("'")) return v.slice(1, -1).replaceAll("''", "'")
    if (v.startsWith('"')) {
      return v.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))
    }
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) throw new Error(`line ${i}: multi-line flow sequence: ${v}`)
      const inner = v.slice(1, -1).trim()
      return inner === '' ? [] : inner.split(',').map((part) => scalar(part))
    }
    return v === '' || v === '~' || v === 'null' ? null : v
  }

  function blockScalar(parentIndent: number, indicator: string): string {
    const body: string[] = []
    let contentIndent: number | undefined
    while (i < raw.length) {
      const line = raw[i]!
      if (line.trim() === '') {
        body.push('')
        i += 1
        continue
      }
      const ind = indentOf(line)
      if (ind <= parentIndent) break
      contentIndent ??= ind
      body.push(line.slice(contentIndent))
      i += 1
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    const text = indicator.startsWith('>') ? body.join(' ') : body.join('\n')
    return indicator.endsWith('-') ? text : `${text}\n`
  }

  function node(minIndent: number): Yaml {
    skipBlank()
    if (i >= raw.length) return null
    const ind = indentOf(raw[i]!)
    if (ind < minIndent) return null
    return isSeqItem(raw[i]!.trimStart()) ? sequence(ind) : mapping(ind)
  }

  function sequence(ind: number): Yaml[] {
    const out: Yaml[] = []
    for (;;) {
      skipBlank()
      if (i >= raw.length) break
      const line = raw[i]!
      const text = line.trimStart()
      if (indentOf(line) !== ind || !isSeqItem(text)) break
      const rest = text.slice(1)
      const content = rest.trimStart()
      if (content === '') {
        i += 1
        out.push(node(ind + 1))
      } else if (MAP_ENTRY.test(content)) {
        const col = ind + 1 + (rest.length - content.length)
        raw[i] = ' '.repeat(col) + content
        out.push(mapping(col))
      } else {
        i += 1
        out.push(scalar(content))
      }
    }
    return out
  }

  function mapping(ind: number): { [key: string]: Yaml } {
    const out: { [key: string]: Yaml } = {}
    for (;;) {
      skipBlank()
      if (i >= raw.length) break
      const line = raw[i]!
      const lineIndent = indentOf(line)
      if (lineIndent < ind) break
      if (lineIndent > ind) throw new Error(`line ${i + 1}: unexpected indentation: ${line}`)
      const text = line.trimStart()
      if (isSeqItem(text)) break
      const m = MAP_ENTRY.exec(text)
      if (m === null) throw new Error(`line ${i + 1}: not a mapping entry: ${text}`)
      const key = m[1]!.replace(/^(["'])(.*)\1$/, '$2')
      if (key in out) throw new Error(`line ${i + 1}: duplicate key ${key}`)
      const value = stripComment(m[2] ?? '')
      i += 1
      if (value === '') {
        skipBlank()
        const next = raw[i]
        if (next !== undefined && indentOf(next) === ind && isSeqItem(next.trimStart())) {
          out[key] = sequence(ind)
        } else {
          out[key] = node(ind + 1)
        }
      } else if (/^[|>][-+]?$/.test(value)) {
        out[key] = blockScalar(ind, value)
      } else {
        out[key] = scalar(value)
      }
    }
    return out
  }

  const doc = node(0)
  skipBlank()
  if (i < raw.length) throw new Error(`line ${i + 1}: unparsed content: ${raw[i]}`)
  return doc
}

type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string>
}
type Job = {
  needs?: string | string[]
  if?: string
  env?: Record<string, string>
  services?: Record<string, { image?: string }>
  strategy?: { matrix?: Record<string, Yaml> }
  steps?: Step[]
}

/** The job keys as they appear in the text: two-space keys under the top-level `jobs:`. */
function textualJobIds(source: string): string[] {
  const ids: string[] = []
  let inJobs = false
  for (const line of source.split('\n')) {
    if (/^\S/.test(line) && !line.startsWith('#')) inJobs = /^jobs:\s*(?:#.*)?$/.test(line)
    const m = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line) : null
    if (m !== null) ids.push(m[1]!)
  }
  return ids
}

type Workflow = { env?: Record<string, string>; jobs: Record<string, Job> }

function loadWorkflow(file: string): Workflow {
  const source = readFileSync(file, 'utf8')
  const doc = parseYaml(source) as { env?: Record<string, string>; jobs?: Record<string, Job> }
  const jobs = doc.jobs ?? {}
  const parsed = Object.keys(jobs)
  const textual = textualJobIds(source)
  if (parsed.join(',') !== textual.join(',')) {
    throw new Error(`${file} misread: parsed jobs [${parsed}] but the text has [${textual}]`)
  }
  return { ...(doc.env === undefined ? {} : { env: doc.env }), jobs }
}

function loadJobs(): Record<string, Job> {
  return loadWorkflow(WORKFLOW).jobs
}

const runs = (job: Job): string[] =>
  (job.steps ?? []).flatMap((s) => (typeof s.run === 'string' ? [s.run.replace(/\\\n/g, ' ')] : []))
const needsOf = (job: Job): string[] =>
  job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]

/** `pnpm build`, `pnpm build:templates`, `pnpm --filter X build`, `pnpm run build`, or a framework build. */
const BUILD =
  /\bpnpm\s+(?:(?:-r|--recursive|(?:--filter|-F)(?:=|\s+)\S+)\s+)*(?:run\s+)?build(?::templates)?\b|\b(?:vite|astro|next|tsup)\s+build\b/

const RUNS_TESTS =
  /scripts\/gate\.ts|\bgate:full\b|\bvitest\b|\bplaywright\s+test\b|\bstryker\b|\bpnpm\s+(?:run\s+)?(?:test|mutation|sentinels)\b|create-nymbal-app/

/** The pull-request jobs the spec names (besides build and the P0-04 changeset job). */
const SPEC_JOBS = [
  'gate',
  'integration',
  'mutation',
  'sentinels',
  'e2e-astro',
  'e2e-nextjs',
  'e2e-admin',
  'scaffold-smoke',
]

function uploadsOf(job: Job): Step[] {
  return (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/upload-artifact@'))
}

function artefactName(step: Step): string {
  return step.with?.name ?? 'artifact'
}

/** Shell words, honouring single and double quotes (step names such as 'census trend' hold spaces). */
function words(text: string): string[] {
  const out: string[] = []
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g
  let current = ''
  let last = -1
  for (const m of text.matchAll(re)) {
    const piece = m[1] ?? m[2] ?? m[3] ?? ''
    if (last === m.index) current += piece
    else {
      if (last !== -1) out.push(current)
      current = piece
    }
    last = m.index + m[0].length
  }
  if (last !== -1) out.push(current)
  return out
}

/** Each gate.ts (or gate:full) invocation in a run script: the words after it, up to the end of that command. */
function gateInvocations(script: string): string[][] {
  const found: string[][] = []
  for (const m of script.matchAll(
    /(?:scripts\/gate\.ts|\bpnpm\s+(?:run\s+)?gate:full)([^\n;&|]*)/g,
  )) {
    found.push(words(m[1] ?? ''))
  }
  return found
}

function flag(args: string[], name: string): string | undefined {
  const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (at === -1) return undefined
  const arg = args[at]!
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[at + 1]
}

describe('AC-4: one artefact, built once, downloaded by every other job', () => {
  it('AC-4: the build job runs the builds and uploads one artefact holding packages, templates and admin', () => {
    const build = loadJobs().build
    expect(build, 'ci.yml has a build job').toBeDefined()
    const uploads = uploadsOf(build!)
    expect(uploads).toHaveLength(1)
    const path = uploads[0]!.with?.path ?? ''
    const missing = ['packages/', 'templates/', 'apps/admin'].filter((p) => !path.includes(p))
    expect(missing, `upload path:\n${path}`).toEqual([])
    const scripts = runs(build!).join('\n')
    expect(scripts).toMatch(/\bpnpm\s+build(?!:)\b/)
    expect(scripts).toMatch(/\bpnpm\s+build:templates\b/)
  })

  it('AC-4: no job but build runs pnpm build or pnpm build:templates', () => {
    const jobs = loadJobs()
    const offenders = Object.entries(jobs)
      .filter(([id]) => id !== 'build')
      .flatMap(([id, job]) =>
        runs(job)
          .filter((script) => BUILD.test(script))
          .map((script) => `${id}: ${script.trim().split('\n')[0]}`),
      )
    expect(offenders).toEqual([])
  })

  it('AC-4: every job that runs tests needs build and downloads, before its first test, the artefact build uploads', () => {
    const jobs = loadJobs()
    const testJobs = Object.keys(jobs).filter(
      (id) => id !== 'build' && runs(jobs[id]!).some((script) => RUNS_TESTS.test(script)),
    )
    expect(
      SPEC_JOBS.filter((id) => !testJobs.includes(id)),
      `test jobs: ${testJobs}`,
    ).toEqual([])

    const upload = uploadsOf(jobs.build ?? {})[0]
    expect(upload, 'build uploads an artefact').toBeDefined()
    const failures: string[] = []
    for (const id of testJobs) {
      const job = jobs[id]!
      if (!needsOf(job).includes('build')) failures.push(`${id}: does not need build`)
      const steps = job.steps ?? []
      const download = steps.findIndex(
        (s) =>
          s.uses?.startsWith('actions/download-artifact@') &&
          (s.with?.name === undefined || s.with.name === artefactName(upload!)),
      )
      const firstTest = steps.findIndex((s) => typeof s.run === 'string' && RUNS_TESTS.test(s.run))
      if (download === -1) failures.push(`${id}: does not download "${artefactName(upload!)}"`)
      else if (download > firstTest)
        failures.push(`${id}: downloads the artefact after its tests start`)
    }
    expect(failures).toEqual([])
  })

  it('AC-4: every gate.ts invocation outside build names --only steps whose plan runs no build', () => {
    const jobs = loadJobs()
    const failures: string[] = []
    let invocations = 0
    for (const [id, job] of Object.entries(jobs)) {
      if (id === 'build') continue
      for (const script of runs(job)) {
        for (const args of gateInvocations(script)) {
          invocations += 1
          const only = flag(args, '--only')
          if (only === undefined) {
            failures.push(`${id}: gate.ts without --only runs the whole gate, build included`)
            continue
          }
          const external = flag(args, '--services') === 'external'
          const input: PlanInput = {
            full: true,
            base: 'HEAD',
            changed: [],
            mutated: ['packages/sdk/src/client.ts'],
            only: only.split(',').map((n) => n.trim()),
            services: external ? 'external' : 'compose',
            postgresUrl: external ? 'postgres://ci:ci@127.0.0.1:5432/ci' : undefined,
            noBuild: args.includes('--no-build'),
            artefactPresent: true,
          }
          try {
            for (const step of plan(input).steps) {
              if (step.skip === undefined && BUILD.test(step.command)) {
                failures.push(`${id}: --only ${only} runs "${step.name}": ${step.command}`)
              }
            }
          } catch (error) {
            failures.push(
              `${id}: --only ${only}: ${error instanceof Error ? error.message : error}`,
            )
          }
        }
      }
    }
    expect(invocations).toBeGreaterThan(0)
    expect(failures).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Round 1 (review of PR #4): AC-7 (the base every gate.ts call gets), AC-11 (no Postgres in the E2E jobs),
// AC-12 (nightly E2E runs only the mobile projects).
// A workflow is "run" for one event: `${{ }}` expressions are evaluated against a github (and matrix) context, step
// and job `if:` conditions are honoured, env is layered workflow < job < step on top of GitHub's default GITHUB_*
// variables, and `$VAR` / `${VAR}` in an argument is expanded from that env or from a plain `VAR=value` line earlier
// in the same script. Anything outside that subset throws, so an unreadable form fails loudly rather than passing.
// ---------------------------------------------------------------------------------------------------------------

type Ctx = Record<string, unknown>

/** A GitHub Actions expression, for the subset workflows use: literals, context paths, ! == != && || and calls. */
function evaluate(source: string, ctx: Ctx): unknown {
  const tokens: string[] = []
  const re =
    /\s*('(?:[^']|'')*'|\d+(?:\.\d+)?|==|!=|&&|\|\||[!(),]|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)/y
  let at = 0
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break
    re.lastIndex = at
    const m = re.exec(source)
    if (m === null) throw new Error(`unsupported expression at "${source.slice(at)}": ${source}`)
    tokens.push(m[1]!)
    at = re.lastIndex
  }
  let i = 0
  const peek = (): string | undefined => tokens[i]
  const take = (expected?: string): string => {
    const t = tokens[i]
    if (t === undefined || (expected !== undefined && t !== expected)) {
      throw new Error(`expected ${expected ?? 'a token'} in: ${source}`)
    }
    i += 1
    return t
  }
  const truthy = (v: unknown): boolean =>
    v !== null && v !== undefined && v !== false && v !== '' && v !== 0
  const equal = (a: unknown, b: unknown): boolean => {
    if ((a ?? null) === null || (b ?? null) === null) return (a ?? null) === (b ?? null)
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
    return a === b
  }
  const call = (name: string, args: unknown[]): unknown => {
    const s = args.map((a) => text(a))
    switch (name) {
      case 'format':
        return s[0]!.replace(/\{(\d+)\}/g, (_, n: string) => s[Number(n) + 1] ?? '')
      case 'startsWith':
        return s[0]!.toLowerCase().startsWith(s[1]!.toLowerCase())
      case 'endsWith':
        return s[0]!.toLowerCase().endsWith(s[1]!.toLowerCase())
      case 'contains':
        return Array.isArray(args[0])
          ? args[0].some((x) => equal(x, args[1]))
          : s[0]!.toLowerCase().includes(s[1]!.toLowerCase())
      case 'success':
      case 'always':
        return true
      case 'failure':
      case 'cancelled':
        return false
      default:
        throw new Error(`unsupported function ${name}() in: ${source}`)
    }
  }
  function primary(): unknown {
    const t = take()
    if (t === '(') {
      const v = or()
      take(')')
      return v
    }
    if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'")
    if (/^\d/.test(t)) return Number(t)
    if (t === 'true') return true
    if (t === 'false') return false
    if (t === 'null') return null
    if (peek() === '(') {
      take('(')
      const args: unknown[] = []
      while (peek() !== ')') {
        args.push(or())
        if (peek() === ',') take(',')
      }
      take(')')
      return call(t, args)
    }
    let v: unknown = ctx
    for (const key of t.split('.')) {
      v = v !== null && typeof v === 'object' ? (v as Ctx)[key] : undefined
    }
    return v ?? null
  }
  function unary(): unknown {
    if (peek() === '!') {
      take('!')
      return !truthy(unary())
    }
    return primary()
  }
  function comparison(): unknown {
    const left = unary()
    const op = peek()
    if (op === '==' || op === '!=') {
      take()
      const right = unary()
      return op === '==' ? equal(left, right) : !equal(left, right)
    }
    return left
  }
  function and(): unknown {
    let v = comparison()
    while (peek() === '&&') {
      take()
      const r = comparison()
      v = truthy(v) ? r : v
    }
    return v
  }
  function or(): unknown {
    let v = and()
    while (peek() === '||') {
      take()
      const r = and()
      v = truthy(v) ? v : r
    }
    return v
  }
  const value = or()
  if (i !== tokens.length) throw new Error(`unparsed "${tokens.slice(i).join(' ')}" in: ${source}`)
  return value
}

function text(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

function substitute(source: string, ctx: Ctx): string {
  return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr: string) => text(evaluate(expr, ctx)))
}

function holds(condition: string | undefined, ctx: Ctx): boolean {
  if (condition === undefined) return true
  const bare = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition)?.[1] ?? condition
  const v = evaluate(bare, ctx)
  return v !== null && v !== undefined && v !== false && v !== '' && v !== 0
}

function layer(env: Record<string, string> | undefined, ctx: Ctx): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([k, v]) => [k, substitute(text(v), ctx)]),
  )
}

/** Every combination of a job's matrix (one empty combination when it has none). */
function combinations(job: Job): Array<Record<string, string>> {
  const matrix = job.strategy?.matrix
  if (matrix === undefined) return [{}]
  let out: Array<Record<string, string>> = [{}]
  for (const [key, values] of Object.entries(matrix)) {
    if (!Array.isArray(values)) throw new Error(`unsupported matrix entry ${key}`)
    out = out.flatMap((combo) => values.map((v) => ({ ...combo, [key]: text(v) })))
  }
  return out
}

type Executed = {
  job: string
  matrix: Record<string, string>
  script: string
  env: Record<string, string>
}

/** The run scripts that execute for an event, expressions substituted, with the env each one sees. */
function execute(workflow: Workflow, github: Ctx): Executed[] {
  const defaults: Record<string, string> = {
    GITHUB_EVENT_NAME: text(github.event_name),
    GITHUB_BASE_REF: text(github.base_ref),
    GITHUB_HEAD_REF: text(github.head_ref),
    GITHUB_REF: text(github.ref),
    GITHUB_REF_NAME: text(github.ref_name),
    GITHUB_SHA: text(github.sha),
  }
  const out: Executed[] = []
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const matrix of combinations(job)) {
      const base: Ctx = {
        github,
        matrix,
        inputs: {},
        vars: {},
        secrets: {},
        runner: { os: 'Linux' },
      }
      const wfEnv = layer(workflow.env, { ...base, env: {} })
      if (!holds(job.if, { ...base, env: wfEnv })) continue
      const jobEnv = { ...wfEnv, ...layer(job.env, { ...base, env: wfEnv }) }
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue
        const stepEnv = { ...jobEnv, ...layer(step.env, { ...base, env: jobEnv }) }
        const ctx = { ...base, env: stepEnv }
        if (!holds(step.if, ctx)) continue
        out.push({
          job: id,
          matrix,
          script: substitute(step.run.replace(/\\\n/g, ' '), ctx),
          env: { ...defaults, ...stepEnv },
        })
      }
    }
  }
  return out
}

/** `$VAR` and `${VAR}` expanded from the env, or from a plain `VAR=value` line before `offset` in the script. */
function expand(word: string, run: Executed, offset: number): string {
  const assigned: Record<string, string> = {}
  for (const line of run.script.slice(0, offset).split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(\S.*)?$/.exec(line)
    if (m !== null) assigned[m[1]!] = words(m[2] ?? '').join(' ')
  }
  return word.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (raw, a, b) => {
      const name = (a ?? b) as string
      const value = assigned[name] ?? run.env[name]
      if (value === undefined)
        throw new Error(`${run.job}: $${name} is not set where gate.ts reads it`)
      return value
    },
  )
}

type GateCall = { job: string; args: string[]; base: string | undefined }

function gateCalls(workflow: Workflow, github: Ctx): GateCall[] {
  const calls: GateCall[] = []
  for (const run of execute(workflow, github)) {
    for (const m of run.script.matchAll(
      /(?:scripts\/gate\.ts|\bpnpm\s+(?:run\s+)?gate:full)([^\n;&|]*)/g,
    )) {
      const args = words(m[1] ?? '').map((w) => expand(w, run, m.index))
      calls.push({ job: run.job, args, base: flag(args, '--base') })
    }
  }
  return calls
}

const sha = (c: string): string => c.repeat(40)

const PR_OPENED = {
  event_name: 'pull_request',
  base_ref: 'dev',
  head_ref: 'feat/P0-03-ci-rebuilt',
  ref: 'refs/pull/4/merge',
  ref_name: '4/merge',
  sha: sha('1'),
  event: {
    action: 'opened',
    number: 4,
    pull_request: { base: { ref: 'dev', sha: sha('2') }, head: { ref: 'feat/x', sha: sha('3') } },
  },
}

const CI_EVENTS: Array<{ label: string; github: Ctx; expected: string }> = [
  { label: 'a pull request opened into dev', github: PR_OPENED, expected: 'origin/dev' },
  {
    // A synchronize payload carries `before` too: it must not win over the base branch.
    label: 'a pull request into main, synchronized',
    github: {
      ...PR_OPENED,
      base_ref: 'main',
      event: {
        action: 'synchronize',
        number: 5,
        before: sha('4'),
        after: sha('5'),
        pull_request: {
          base: { ref: 'main', sha: sha('6') },
          head: { ref: 'feat/x', sha: sha('5') },
        },
      },
    },
    expected: 'origin/main',
  },
  {
    label: 'a push to dev',
    github: {
      event_name: 'push',
      base_ref: '',
      head_ref: '',
      ref: 'refs/heads/dev',
      ref_name: 'dev',
      sha: sha('a'),
      event: { before: sha('b'), after: sha('a'), ref: 'refs/heads/dev' },
    },
    expected: sha('b'),
  },
  {
    label: 'a push to main',
    github: {
      event_name: 'push',
      base_ref: '',
      head_ref: '',
      ref: 'refs/heads/main',
      ref_name: 'main',
      sha: sha('c'),
      event: { before: sha('d'), after: sha('c'), ref: 'refs/heads/main' },
    },
    expected: sha('d'),
  },
]

const NIGHTLY_EVENTS: Array<{ label: string; github: Ctx }> = [
  {
    label: 'schedule',
    github: {
      event_name: 'schedule',
      base_ref: '',
      ref: 'refs/heads/main',
      ref_name: 'main',
      sha: sha('e'),
      event: { schedule: '0 3 * * *' },
    },
  },
  {
    label: 'workflow_dispatch',
    github: {
      event_name: 'workflow_dispatch',
      base_ref: '',
      ref: 'refs/heads/dev',
      ref_name: 'dev',
      sha: sha('f'),
      event: { inputs: {} },
    },
  },
]

/** Jobs that call gate.ts but check out a shallow clone, where neither origin/<base> nor `before` resolves. */
function shallowGateJobs(workflow: Workflow, calls: GateCall[]): string[] {
  return [...new Set(calls.map((c) => c.job))].filter((id) => {
    const checkout = (workflow.jobs[id]?.steps ?? []).find((s) =>
      s.uses?.startsWith('actions/checkout@'),
    )
    return text(checkout?.with?.['fetch-depth']) !== '0'
  })
}

describe('AC-7: CI passes the right base to every gate.ts call', () => {
  const ci = loadWorkflow(WORKFLOW)
  const prJobs = new Set(gateCalls(ci, PR_OPENED).map((c) => c.job))

  it.each(CI_EVENTS)(
    'AC-7: on $label, every gate.ts call in ci.yml passes --base $expected',
    ({ github, expected }) => {
      const calls = gateCalls(ci, github)
      expect(calls.length, 'gate.ts calls that run').toBeGreaterThan(0)
      const missing = [...prJobs].filter((id) => !calls.some((c) => c.job === id))
      expect(missing, 'jobs that call gate.ts on a pull request but not on this event').toEqual([])
      const wrong = calls
        .filter((c) => c.base !== expected)
        .map((c) => `${c.job}: --base ${c.base ?? '(none)'}`)
      expect(wrong).toEqual([])
      expect(shallowGateJobs(ci, calls), 'gate.ts jobs without fetch-depth: 0').toEqual([])
    },
  )

  it.each(NIGHTLY_EVENTS)(
    'AC-7: on $label, every gate.ts or gate:full call in nightly.yml passes --base HEAD~1',
    ({ github }) => {
      const nightly = loadWorkflow(NIGHTLY)
      const calls = gateCalls(nightly, github)
      expect(calls.length, 'gate calls that run').toBeGreaterThan(0)
      const wrong = calls
        .filter((c) => c.base !== 'HEAD~1')
        .map((c) => `${c.job}: --base ${c.base ?? '(none)'}`)
      expect(wrong).toEqual([])
      expect(shallowGateJobs(nightly, calls), 'gate jobs without fetch-depth: 0').toEqual([])
    },
  )
})

describe('AC-11: the E2E jobs start no Postgres service, and their gate.ts call still runs its E2E step', () => {
  it('AC-11: no ci.yml e2e job has a Postgres service; each runs its e2e step with the env the job gives it', () => {
    const ci = loadWorkflow(WORKFLOW)
    const e2eJobs = Object.keys(ci.jobs).filter((id) => id.startsWith('e2e'))
    expect(e2eJobs.length).toBeGreaterThanOrEqual(3)

    const failures: string[] = []
    let e2eSteps = 0
    for (const id of e2eJobs) {
      for (const [name, service] of Object.entries(ci.jobs[id]?.services ?? {})) {
        if (/postgres/i.test(`${name} ${service?.image ?? ''}`)) {
          failures.push(`${id}: starts service ${name} (${service?.image ?? 'no image'})`)
        }
      }
    }
    for (const call of gateCalls(ci, PR_OPENED).filter((c) => e2eJobs.includes(c.job))) {
      const only = flag(call.args, '--only')
      const run = execute(ci, PR_OPENED).find((r) => r.job === call.job)
      const steps = plan({
        full: true,
        base: 'HEAD',
        changed: [],
        mutated: [],
        ...(only === undefined ? {} : { only: only.split(',').map((n) => n.trim()) }),
        services: flag(call.args, '--services') === 'external' ? 'external' : 'compose',
        postgresUrl: run?.env.NYMBAL_TEST_POSTGRES_URL || undefined,
        noBuild: call.args.includes('--no-build'),
        artefactPresent: true,
      }).steps
      for (const step of steps.filter((s) => s.name.startsWith('e2e'))) {
        e2eSteps += 1
        if (step.skip !== undefined)
          failures.push(`${call.job}: "${step.name}" is skipped: ${step.skip}`)
      }
    }
    expect(e2eSteps).toBeGreaterThanOrEqual(e2eJobs.length)
    expect(failures).toEqual([])
  })
})

/** The projects a `playwright test` command selects: `--project a`, `--project=a`, or `--project a b`. */
function playwrightProjects(script: string): string[][] {
  const found: string[][] = []
  for (const m of script.matchAll(/\bplaywright\s+test\b([^\n;&|]*)/g)) {
    const args = words(m[1] ?? '')
    const projects: string[] = []
    for (let k = 0; k < args.length; k += 1) {
      const arg = args[k]!
      if (arg.startsWith('--project=')) projects.push(arg.slice('--project='.length))
      else if (arg === '--project') {
        while (k + 1 < args.length && !args[k + 1]!.startsWith('-')) {
          k += 1
          projects.push(args[k]!)
        }
      }
    }
    found.push(projects)
  }
  return found
}

describe('AC-12: nightly e2e-full runs only the -mobile projects', () => {
  it('AC-12: for each matrix target, every playwright test call in e2e-full selects exactly <target>-mobile', () => {
    const nightly = loadWorkflow(NIGHTLY)
    expect(nightly.jobs['e2e-full'], 'nightly.yml has an e2e-full job').toBeDefined()
    const targets = combinations(nightly.jobs['e2e-full']!).map((m) => m.target)
    expect(targets.length).toBeGreaterThanOrEqual(3)

    const runs = execute(nightly, NIGHTLY_EVENTS[0]!.github).filter((r) => r.job === 'e2e-full')
    for (const target of targets) {
      const calls = runs
        .filter((r) => r.matrix.target === target)
        .flatMap((r) => playwrightProjects(r.script))
      expect(calls.length, `${target}: playwright test calls`).toBeGreaterThan(0)
      for (const projects of calls) {
        expect([...projects].sort(), `${target}: --project values`).toEqual([`${target}-mobile`])
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// P1-01 AC-18, the CI half (the gate:full and `pnpm test` halves are in proof-kit-wiring.test.ts): the integration
// job runs the proof-kit-services Vitest project, directly or through a gate.ts step, with a Mailpit service whose
// published ports are the ones the URLs the command sees point at.
// ---------------------------------------------------------------------------------------------------------------

const KIT_SERVICES = 'proof-kit-services'

function runsKitServices(command: string): boolean {
  return new RegExp(
    `\\bvitest\\b[^;&|\\n]*--project(?:=|\\s+)['"]?${KIT_SERVICES}['"]?(?:\\s|$)`,
  ).test(command)
}

/** `NAME=value` assignments in a command. */
function assignedIn(command: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of command.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=('[^']*'|"[^"]*"|\S+)/g)) {
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** container port -> host port, from a service's `ports` list of 'host:container' entries. */
function publishedPorts(service: unknown): Map<string, string> {
  const ports = (service as { ports?: Yaml } | undefined)?.ports
  const out = new Map<string, string>()
  for (const entry of Array.isArray(ports) ? ports : []) {
    const m = /^(?:[\d.]+:)?(\d+):(\d+)(?:\/tcp)?$/.exec(text(entry))
    if (m !== null) out.set(m[2]!, m[1]!)
  }
  return out
}

const portOf = (address: string): string =>
  new URL(address.includes('://') ? address : `smtp://${address}`).port

describe('AC-18 (P1-01): the CI integration job runs proof-kit-services with a Mailpit service', () => {
  it('AC-18: the integration job runs proof-kit-services with both URLs set, and its Mailpit service publishes the ports they name', () => {
    const ci = loadWorkflow(WORKFLOW)
    const job = ci.jobs.integration
    expect(job, 'ci.yml has an integration job').toBeDefined()
    const mailpit = Object.values(job?.services ?? {}).find((s) =>
      (s?.image ?? '').startsWith('axllent/mailpit'),
    )
    expect(mailpit?.image ?? '(no Mailpit service)').toMatch(/^axllent\/mailpit:/)
    const ports = publishedPorts(mailpit)

    const kitRuns: Array<{ via: string; env: Record<string, string> }> = []
    for (const run of execute(ci, PR_OPENED).filter((r) => r.job === 'integration')) {
      if (runsKitServices(run.script)) {
        kitRuns.push({ via: 'vitest', env: { ...run.env, ...assignedIn(run.script) } })
      }
      for (const m of run.script.matchAll(
        /(?:scripts\/gate\.ts|\bpnpm\s+(?:run\s+)?gate:full)([^\n;&|]*)/g,
      )) {
        const args = words(m[1] ?? '').map((w) => expand(w, run, m.index))
        const only = flag(args, '--only')
        const external = flag(args, '--services') === 'external'
        const input = {
          full: true,
          base: 'HEAD',
          changed: [],
          mutated: [],
          ...(only === undefined ? {} : { only: only.split(',').map((n) => n.trim()) }),
          services: external ? 'external' : 'compose',
          postgresUrl: run.env.NYMBAL_TEST_POSTGRES_URL || undefined,
          mailpitUrl: run.env.NYMBAL_TEST_MAILPIT_URL || undefined,
          noBuild: args.includes('--no-build'),
          artefactPresent: true,
        } as PlanInput
        for (const step of plan(input).steps) {
          if (step.skip === undefined && runsKitServices(step.command)) {
            kitRuns.push({
              via: `gate.ts "${step.name}"`,
              env: { ...run.env, ...assignedIn(step.command) },
            })
          }
        }
      }
    }
    expect(kitRuns.length, 'integration-job commands that run proof-kit-services').toBeGreaterThan(
      0,
    )

    const problems = kitRuns.flatMap(({ via, env }) => {
      const found: string[] = []
      if (!env.NYMBAL_TEST_POSTGRES_URL) found.push(`${via}: NYMBAL_TEST_POSTGRES_URL is not set`)
      const api = env.NYMBAL_TEST_MAILPIT_URL
      if (!api) found.push(`${via}: NYMBAL_TEST_MAILPIT_URL is not set`)
      else if (portOf(api) !== ports.get('8025')) {
        found.push(
          `${via}: Mailpit API ${api} is not the service's published 8025 (${ports.get('8025')})`,
        )
      }
      const smtp = env.NYMBAL_TEST_MAILPIT_SMTP ?? 'localhost:11025'
      if (portOf(smtp) !== ports.get('1025')) {
        found.push(
          `${via}: Mailpit SMTP ${smtp} is not the service's published 1025 (${ports.get('1025')})`,
        )
      }
      return found
    })
    expect(problems).toEqual([])
  })
})

describe('AC-18 (P1-01): tests-fail-on-base in CI has the Mailpit the kit tests need', () => {
  it('AC-18: every CI job whose gate.ts call runs tests-fail-on-base has a Mailpit service, and the step sees NYMBAL_TEST_MAILPIT_URL at its published 8025', () => {
    const ci = loadWorkflow(WORKFLOW)
    const problems: string[] = []
    let runsBase = 0
    for (const call of gateCalls(ci, PR_OPENED)) {
      const run = execute(ci, PR_OPENED).find((r) => r.job === call.job)!
      const only = flag(call.args, '--only')
      const external = flag(call.args, '--services') === 'external'
      const input = {
        full: true,
        base: 'HEAD',
        changed: [],
        mutated: [],
        ...(only === undefined ? {} : { only: only.split(',').map((n) => n.trim()) }),
        services: external ? 'external' : 'compose',
        postgresUrl: run.env.NYMBAL_TEST_POSTGRES_URL || undefined,
        mailpitUrl: run.env.NYMBAL_TEST_MAILPIT_URL || undefined,
        noBuild: call.args.includes('--no-build'),
        artefactPresent: true,
      } as PlanInput
      for (const step of plan(input).steps) {
        if (step.name !== 'tests-fail-on-base' || step.skip !== undefined) continue
        runsBase += 1
        const mailpit = Object.values(ci.jobs[call.job]?.services ?? {}).find((s) =>
          (s?.image ?? '').startsWith('axllent/mailpit'),
        )
        const published = publishedPorts(mailpit)
        const api = { ...run.env, ...assignedIn(step.command) }.NYMBAL_TEST_MAILPIT_URL
        if (mailpit === undefined) problems.push(`${call.job}: no Mailpit service`)
        if (!api) problems.push(`${call.job}: NYMBAL_TEST_MAILPIT_URL is not set`)
        else if (portOf(api) !== published.get('8025')) {
          problems.push(
            `${call.job}: ${api} is not Mailpit's published 8025 (${published.get('8025')})`,
          )
        }
      }
    }
    expect(runsBase, 'CI gate.ts calls that run tests-fail-on-base').toBeGreaterThan(0)
    expect(problems).toEqual([])
  })
})
