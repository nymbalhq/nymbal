// Reads: .github/workflows/ci.yml, .github/workflows/nightly.yml, .github/workflows/release.yml, package.json
// Reads: .github/workflows/nightly-trigger.yml, pnpm-lock.yaml, tests/e2e/package.json
// Reads: .github/workflows/registry.yml
// Reads: stryker.config.mjs, stryker.integration.config.mjs, scripts/mutation-ratchet.ts
// Reads: tests/perf/perf-budgets.test.ts
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  emptyTree,
  HARNESS_PROJECTS,
  type PlanInput,
  plan,
  resolveBase,
  stepModes,
} from '../../scripts/gate'
import { childEnv, cleanupScratch, git, REPO, scratchRepo } from './scratch-gate'
import { leftOut } from './vitest-filters'

// AC-4: every CI job except `build` downloads the one artefact `build` uploads, and none of them runs `pnpm build`
// (directly, or through a gate.ts plan that would).
// No YAML library is a dependency of the repo, so the workflow is read by the small block-YAML reader below. It
// throws on anything outside the subset GitHub workflows here use, and the job list it returns is checked against
// the job keys found textually, so a misread fails loudly instead of passing quietly.

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url))
const NIGHTLY = fileURLToPath(new URL('../../.github/workflows/nightly.yml', import.meta.url))
const NIGHTLY_TRIGGER = fileURLToPath(
  new URL('../../.github/workflows/nightly-trigger.yml', import.meta.url),
)

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
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string>
  'continue-on-error'?: string
}
type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  env?: Record<string, string>
  permissions?: Record<string, string>
  services?: Record<string, { image?: string }>
  strategy?: { matrix?: Record<string, Yaml> }
  steps?: Step[]
  'continue-on-error'?: string
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

type Workflow = {
  on?: Yaml
  'run-name'?: string
  permissions?: Record<string, string>
  env?: Record<string, string>
  jobs: Record<string, Job>
}

function loadWorkflow(file: string): Workflow {
  const source = readFileSync(file, 'utf8')
  const doc = parseYaml(source) as Omit<Workflow, 'jobs'> & { jobs?: Record<string, Job> }
  const jobs = doc.jobs ?? {}
  const parsed = Object.keys(jobs)
  const textual = textualJobIds(source)
  if (parsed.join(',') !== textual.join(',')) {
    throw new Error(`${file} misread: parsed jobs [${parsed}] but the text has [${textual}]`)
  }
  return { ...doc, jobs }
}

/** The events a workflow's `on:` names, in any of its three forms (a name, a list, a map). */
function eventsOf(workflow: Pick<Workflow, 'on'>): string[] {
  const on = workflow.on
  if (typeof on === 'string') return [on]
  if (Array.isArray(on)) return on.map((e) => text(e))
  return on === null || on === undefined ? [] : Object.keys(on)
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

/** The CI jobs that must use the build artefact (besides build itself). */
const SPEC_JOBS = [
  'gate-tests',
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
// AC-7 (the base every gate.ts call gets), AC-11 (no Postgres in the E2E jobs), AC-12 (nightly E2E runs only the
// mobile projects).
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
    // GitHub coerces mismatched types to numbers: `matrix.shard == 1` holds for the matrix value 1.
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
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
      case 'hashFiles': {
        const hash = (ctx as { hashFiles?: (patterns: string[]) => string }).hashFiles
        if (hash === undefined) throw new Error(`hashFiles() has no files to hash in: ${source}`)
        return hash(s)
      }
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

/**
 * The run scripts that execute for an event, expressions substituted, with the env each one sees. A workflow whose
 * `on:` does not name the event runs nothing, as on GitHub. A dispatch's `inputs` are its event's. `extra` adds or
 * replaces contexts (`steps`, `secrets`, `runner`) for a test that sets what an earlier step or the runner gives.
 */
function execute(workflow: Workflow, github: Ctx, extra: Ctx = {}): Executed[] {
  if (workflow.on !== undefined && !eventsOf(workflow).includes(text(github.event_name))) return []
  const defaults: Record<string, string> = {
    GITHUB_EVENT_NAME: text(github.event_name),
    GITHUB_BASE_REF: text(github.base_ref),
    GITHUB_HEAD_REF: text(github.head_ref),
    GITHUB_REF: text(github.ref),
    GITHUB_REF_NAME: text(github.ref_name),
    GITHUB_SHA: text(github.sha),
    GITHUB_REPOSITORY: text(github.repository),
  }
  const inputs = ((github.event as Ctx | undefined)?.inputs as Ctx | undefined) ?? {}
  const out: Executed[] = []
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const matrix of combinations(job)) {
      const base: Ctx = {
        github,
        matrix,
        inputs,
        vars: {},
        secrets: {},
        runner: { os: 'Linux' },
        steps: {},
        ...extra,
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

// Work merges into dev locally, so a push to dev is the event every CI job is judged on.
const DEV_PUSH = {
  event_name: 'push',
  base_ref: '',
  head_ref: '',
  ref: 'refs/heads/dev',
  ref_name: 'dev',
  sha: sha('a'),
  event: {
    before: sha('b'),
    after: sha('a'),
    ref: 'refs/heads/dev',
    head_commit: { message: 'Merge feat/local-merges: Local merges to dev' },
  },
}

const MAIN_PUSH = {
  event_name: 'push',
  base_ref: '',
  head_ref: '',
  ref: 'refs/heads/main',
  ref_name: 'main',
  sha: sha('c'),
  event: { before: sha('d'), after: sha('c'), ref: 'refs/heads/main' },
}

// The release's dispatch: every job, diffed against origin/main's sha, which the dispatch passes as `base`.
const DEV_DISPATCH = {
  event_name: 'workflow_dispatch',
  base_ref: '',
  head_ref: '',
  ref: 'refs/heads/dev',
  ref_name: 'dev',
  sha: sha('a'),
  event: { inputs: { select: 'all', base: sha('9') } },
}

const CI_EVENTS: Array<{ label: string; github: Ctx; expected: string }> = [
  { label: 'a push to dev', github: DEV_PUSH, expected: sha('b') },
  { label: 'a push to main', github: MAIN_PUSH, expected: sha('d') },
  {
    label: 'a workflow_dispatch on dev with inputs.base (AC-8)',
    github: DEV_DISPATCH,
    expected: sha('9'),
  },
]

const nightlyDispatch = (branch: string, c: string): Ctx => ({
  event_name: 'workflow_dispatch',
  base_ref: '',
  ref: `refs/heads/${branch}`,
  ref_name: branch,
  sha: sha(c),
  repository: 'nymbalhq/nymbal',
  event: { inputs: {} },
})

// The nightly runs by dispatch only (nightly-trigger.yml dispatches dev's copy); a dispatch on main stays possible.
const NIGHTLY_EVENTS: Array<{ label: string; github: Ctx }> = [
  { label: 'a workflow_dispatch on main', github: nightlyDispatch('main', 'e') },
  { label: 'a workflow_dispatch on dev', github: nightlyDispatch('dev', 'f') },
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
  const devJobs = new Set(gateCalls(ci, DEV_PUSH).map((c) => c.job))

  it.each(CI_EVENTS)(
    'AC-7: on $label, every gate.ts call in ci.yml passes --base $expected',
    ({ github, expected }) => {
      const calls = gateCalls(ci, github)
      expect(calls.length, 'gate.ts calls that run').toBeGreaterThan(0)
      const missing = [...devJobs].filter((id) => !calls.some((c) => c.job === id))
      expect(missing, 'jobs that call gate.ts on a push to dev but not on this event').toEqual([])
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

describe('nightly.yml: every gate call has a base that resolves on the commit it checks out', () => {
  afterEach(cleanupScratch)

  // A release can put a root commit at main's head, and a dispatch can run on main: there `HEAD~1` names nothing.
  it.each(NIGHTLY_EVENTS)(
    'on $label, every gate call resolves its base on a root commit, to the empty tree',
    ({ github }) => {
      const nightly = loadWorkflow(NIGHTLY)
      const calls = gateCalls(nightly, github)
      expect(calls.length, 'gate calls that run').toBeGreaterThan(0)
      expect(shallowGateJobs(nightly, calls), 'gate jobs without fetch-depth: 0').toEqual([])
      const repo = scratchRepo({ 'src/a.ts': 'export const a = 1\n' })
      expect(git(repo.root, 'rev-list', '--count', 'HEAD')).toBe('1')
      const resolved = calls.map((c) => {
        try {
          return `${c.job}: ${resolveBase(repo.root, c.base, () => {})}`
        } catch (error) {
          return `${c.job}: ${(error as Error).message}`
        }
      })
      expect(resolved).toEqual(calls.map((c) => `${c.job}: ${emptyTree(repo.root)}`))
    },
  )
})

describe('CI runs on pushes to main and dev, and on a dispatch', () => {
  it('AC-8: ci.yml triggers on push to main and dev and on workflow_dispatch, and on nothing else (no pull_request)', () => {
    const doc = parseYaml(readFileSync(WORKFLOW, 'utf8')) as {
      on?: Record<string, { branches?: string[] }>
    }
    expect({
      events: Object.keys(doc.on ?? {}).sort(),
      branches: [...(doc.on?.push?.branches ?? [])].sort(),
    }).toEqual({ events: ['push', 'workflow_dispatch'], branches: ['dev', 'main'] })
  })
})

type DispatchInput = { type?: string; options?: string[]; required?: string; default?: string }

/**
 * The `inputs` GitHub gives a dispatch of `workflow` asked for with `given`, or the refusal it answers with: an input
 * the workflow does not declare, a required one left out (with no default), or a choice outside its options.
 */
function dispatchInputs(workflow: Workflow, given: Record<string, string>): Record<string, string> {
  const on = workflow.on as {
    workflow_dispatch?: { inputs?: Record<string, DispatchInput> } | null
  }
  if (!eventsOf(workflow).includes('workflow_dispatch')) {
    throw new Error('the workflow does not run on workflow_dispatch')
  }
  const declared = on.workflow_dispatch?.inputs ?? {}
  for (const name of Object.keys(given)) {
    if (!(name in declared)) throw new Error(`Unexpected inputs provided: ${name}`)
  }
  const out: Record<string, string> = {}
  for (const [name, input] of Object.entries(declared)) {
    const value = given[name] ?? text(input.default)
    if (value === '' && text(input.required) === 'true') throw new Error(`${name} is required`)
    if (input.type === 'choice' && !(input.options ?? []).includes(value)) {
      throw new Error(`${name}: ${value} is not one of ${(input.options ?? []).join(', ')}`)
    }
    out[name] = value
  }
  return out
}

/** The ids of the jobs that run at least one step for an event. */
function jobsRun(workflow: Workflow, github: Ctx): string[] {
  return [...new Set(execute(workflow, github).map((r) => r.job))].sort()
}

describe('AC-8: a dispatch runs every job with a real base', () => {
  it('AC-8: a dispatch of ci.yml takes select (all or auto, auto by default) and is refused without a base', () => {
    const ci = loadWorkflow(WORKFLOW)
    const base = sha('9')
    expect(dispatchInputs(ci, { base })).toEqual({ select: 'auto', base })
    expect(dispatchInputs(ci, { select: 'all', base })).toEqual({ select: 'all', base })
    expect(() => dispatchInputs(ci, { select: 'all' })).toThrow('base is required')
    expect(() => dispatchInputs(ci, { select: 'some', base })).toThrow(
      'select: some is not one of all, auto',
    )
  })

  it('AC-8: a workflow_dispatch on dev runs every job a push to dev runs', () => {
    const ci = loadWorkflow(WORKFLOW)
    const onPush = jobsRun(ci, DEV_PUSH)
    expect(onPush.length, 'jobs that run on a push to dev').toBeGreaterThan(10)
    expect(jobsRun(ci, DEV_DISPATCH)).toEqual(onPush)
  })
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
    for (const call of gateCalls(ci, DEV_PUSH).filter((c) => e2eJobs.includes(c.job))) {
      const only = flag(call.args, '--only')
      const run = execute(ci, DEV_PUSH).find((r) => r.job === call.job)
      const steps = plan({
        full: true,
        base: 'HEAD',
        changed: [],
        mutated: [],
        ...(only === undefined ? {} : { only: only.split(',').map((n) => n.trim()) }),
        services: flag(call.args, '--services') === 'external' ? 'external' : 'compose',
        postgresUrl: run?.env.NYMBAL_TEST_POSTGRES_URL || undefined,
        mailpitUrl: run?.env.NYMBAL_TEST_MAILPIT_URL || undefined,
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

// AC-13: the custom-providers store mails through Mailpit, so its two E2E jobs run CI's Mailpit service, pass its
// URLs, and call gate.ts with --services external, under which that URL meets the steps' `mailpit up`.
const MAILPIT_E2E_JOBS: Record<string, string> = {
  'e2e-astro-custom': 'e2e astro-custom',
  'e2e-nextjs-custom': 'e2e nextjs-custom',
}

describe('AC-13: the custom-store E2E jobs have the Mailpit their journeys read', () => {
  it('AC-13: each custom-store E2E job runs a Mailpit service, gives its gate.ts call --services external with NYMBAL_TEST_MAILPIT_URL and NYMBAL_TEST_MAILPIT_SMTP at the service’s published 8025 and 1025, and its e2e step is planned to run', () => {
    const ci = loadWorkflow(WORKFLOW)
    const problems: string[] = []
    let planned = 0
    for (const [id, stepName] of Object.entries(MAILPIT_E2E_JOBS)) {
      const job = ci.jobs[id]
      if (job === undefined) {
        problems.push(`ci.yml has no ${id} job`)
        continue
      }
      const mailpit = Object.values(job.services ?? {}).find((svc) =>
        (svc?.image ?? '').startsWith('axllent/mailpit'),
      )
      const published = publishedPorts(mailpit)
      if (mailpit === undefined) problems.push(`${id}: no Mailpit service`)
      for (const call of gateCalls(ci, DEV_PUSH).filter((c) => c.job === id)) {
        const run = execute(ci, DEV_PUSH).find((r) => r.job === id)!
        const api = run.env.NYMBAL_TEST_MAILPIT_URL
        const smtp = run.env.NYMBAL_TEST_MAILPIT_SMTP
        if (flag(call.args, '--services') !== 'external')
          problems.push(`${id}: not --services external`)
        if (!api || portOf(api) !== published.get('8025')) {
          problems.push(
            `${id}: NYMBAL_TEST_MAILPIT_URL ${api ?? 'unset'} is not the service's 8025`,
          )
        }
        if (!smtp || portOf(smtp) !== published.get('1025')) {
          problems.push(
            `${id}: NYMBAL_TEST_MAILPIT_SMTP ${smtp ?? 'unset'} is not the service's 1025`,
          )
        }
        const only = flag(call.args, '--only')
        const steps = plan({
          full: true,
          base: 'HEAD',
          changed: [],
          mutated: [],
          ...(only === undefined ? {} : { only: only.split(',').map((n) => n.trim()) }),
          services: flag(call.args, '--services') === 'external' ? 'external' : 'compose',
          postgresUrl: run.env.NYMBAL_TEST_POSTGRES_URL || undefined,
          mailpitUrl: api || undefined,
          noBuild: call.args.includes('--no-build'),
          artefactPresent: true,
        } as PlanInput).steps
        const step = steps.find((s) => s.name === stepName)
        if (step === undefined || step.skip !== undefined) {
          problems.push(
            `${id}: "${stepName}" ${step === undefined ? 'is not planned' : `is skipped: ${step.skip}`}`,
          )
        } else planned += 1
      }
    }
    expect(problems).toEqual([])
    expect(planned).toBe(Object.keys(MAILPIT_E2E_JOBS).length)
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
// AC-18, the CI half (the gate:full and `pnpm test` halves are in proof-kit-wiring.test.ts): the integration job runs
// the proof-kit-services Vitest project, directly or through a gate.ts step, with a Mailpit service whose published
// ports are the ones the URLs the command sees point at.
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

describe('AC-18: the CI integration job runs proof-kit-services with a Mailpit service', () => {
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
    for (const run of execute(ci, DEV_PUSH).filter((r) => r.job === 'integration')) {
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

describe('AC-18: tests-fail-on-base in CI has the Mailpit the kit tests need', () => {
  it('AC-18: every CI job whose gate.ts call runs tests-fail-on-base has a Mailpit service, and the step sees NYMBAL_TEST_MAILPIT_URL at its published 8025', () => {
    const ci = loadWorkflow(WORKFLOW)
    const problems: string[] = []
    let runsBase = 0
    for (const call of gateCalls(ci, DEV_PUSH)) {
      const run = execute(ci, DEV_PUSH).find((r) => r.job === call.job)!
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

// The harness's own Vitest projects run in a gate only when a harness path changed; the push to dev is where they
// always run, so the job that runs the tests step asks for them.
const RELEASE = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url))
const PERF_SUITE = fileURLToPath(new URL('../perf/perf-budgets.test.ts', import.meta.url))

type PerfCall = { where: string; args: string[] }

/**
 * Every `perf:budgets` a workflow runs: a direct call, with its arguments, or the tests/perf suite, which spawns
 * `pnpm perf:budgets` with the words of NYMBAL_PERF_BUDGETS_ARGS from the env its step sees.
 */
function perfCalls(workflow: Workflow, github: Ctx): PerfCall[] {
  const calls: PerfCall[] = []
  for (const run of execute(workflow, github)) {
    for (const m of run.script.matchAll(
      /(?:\bpnpm\s+(?:run\s+)?perf:budgets|scripts\/perf-budgets\.ts)([^\n;&|]*)/g,
    )) {
      calls.push({ where: run.job, args: words(m[1] ?? '').map((w) => expand(w, run, m.index)) })
    }
    if (/tests\/perf\/vitest\.config\.ts/.test(run.script)) {
      calls.push({
        where: `${run.job} (tests/perf)`,
        args: words(run.env.NYMBAL_PERF_BUDGETS_ARGS ?? ''),
      })
    }
  }
  return calls
}

describe('perf:budgets takes the median of at least five Lighthouse runs a page', () => {
  it('the tests/perf suite passes NYMBAL_PERF_BUDGETS_ARGS to every perf:budgets it spawns', () => {
    const source = readFileSync(PERF_SUITE, 'utf8')
    const spawns = [...source.matchAll(/spawn\('pnpm', \[([^\]]*)\]/g)].map((m) => m[1])
    expect(spawns).toEqual(["'perf:budgets', ...args, ...FROM_ENV"])
    expect(source).toMatch(/^const FROM_ENV = .*process\.env\.NYMBAL_PERF_BUDGETS_ARGS\b/m)
  })

  // A `--bytes` call measures script bytes with no Lighthouse, so it has no runs to set.
  it.each([
    { label: 'ci.yml on a push to dev', file: WORKFLOW, github: DEV_PUSH, lighthouse: false },
    { label: 'ci.yml on a push to main', file: WORKFLOW, github: MAIN_PUSH, lighthouse: false },
    {
      label: 'ci.yml on a workflow_dispatch',
      file: WORKFLOW,
      github: DEV_DISPATCH,
      lighthouse: true,
    },
    ...NIGHTLY_EVENTS.map((e) => ({
      label: `nightly.yml on ${e.label}`,
      file: NIGHTLY,
      github: e.github,
      lighthouse: true,
    })),
  ])(
    'AC-3: $label, every perf:budgets call but a --bytes one passes --runs 5 or more',
    ({ file, github, lighthouse }) => {
      const calls = perfCalls(loadWorkflow(file), github)
      expect(calls.length, 'perf:budgets calls that run').toBeGreaterThan(0)
      const timed = calls.filter((c) => !isBytes(c))
      expect(timed.length > 0, 'any Lighthouse call runs').toBe(lighthouse)
      const short = timed
        .filter((c) => !(Number(flag(c.args, '--runs')) >= 5))
        .map((c) => `${c.where}: perf:budgets ${c.args.join(' ')}`.trim())
      expect(short).toEqual([])
    },
  )

  it('release.yml runs no perf:budgets, so it has no runs to set', () => {
    expect(readFileSync(RELEASE, 'utf8')).not.toMatch(/perf:budgets|perf-budgets\.ts|tests\/perf\//)
  })
})

const isBytes = (c: PerfCall): boolean => c.args.includes('--bytes')
const PERF_JOB = 'perf-budgets'

/** The config (`-c` or `--config`) of each `playwright test` command in a script. */
function playwrightConfigs(script: string): string[] {
  return [...script.matchAll(/\bplaywright\s+test\b([^\n;&|]*)/g)].map((m) => {
    const args = words(m[1] ?? '')
    return flag(args, '-c') ?? flag(args, '--config') ?? '(the default config)'
  })
}

/** What ci.yml's perf job runs for an event, and how many Lighthouse runs the whole workflow makes. */
function perfJobRuns(github: Ctx): {
  bytes: number
  lighthouse: number
  prod: number
  isr: number
} {
  const ci = loadWorkflow(WORKFLOW)
  const calls = perfCalls(ci, github)
  const configs = execute(ci, github)
    .filter((r) => r.job === PERF_JOB)
    .flatMap((r) => playwrightConfigs(r.script))
  return {
    bytes: calls.filter((c) => c.where === PERF_JOB && isBytes(c)).length,
    lighthouse: calls.filter((c) => !isBytes(c)).length,
    prod: configs.filter((c) => c === 'playwright.prod.config.ts').length,
    isr: configs.filter((c) => c === 'playwright.isr.config.ts').length,
  }
}

describe('AC-3: script bytes on a push, Lighthouse on a dispatch and in the nightly', () => {
  it.each([
    { label: 'a push to dev', github: DEV_PUSH },
    { label: 'a push to main', github: MAIN_PUSH },
  ])(
    'AC-3: on $label, the perf job measures script bytes and runs the prod and ISR E2E, and nothing runs Lighthouse',
    ({ github }) => {
      expect(perfJobRuns(github)).toEqual({ bytes: 1, lighthouse: 0, prod: 1, isr: 1 })
    },
  )

  it('AC-3: on a workflow_dispatch, the perf job runs what a push runs and the tests/perf Lighthouse suite besides', () => {
    const onPush = perfJobRuns(DEV_PUSH)
    expect(perfJobRuns(DEV_DISPATCH)).toEqual({ ...onPush, lighthouse: onPush.lighthouse + 1 })
    const lighthouse = perfCalls(loadWorkflow(WORKFLOW), DEV_DISPATCH).filter((c) => !isBytes(c))
    expect(lighthouse.map((c) => c.where)).toEqual([`${PERF_JOB} (tests/perf)`])
  })
})

const COVERAGE = /\bvitest\b[^\n;&|]*\s--coverage(?:[\s=]|$)/

/** The jobs whose steps, as an event runs them, run Vitest with coverage. */
function coverageJobs(workflow: Workflow, github: Ctx): string[] {
  return [
    ...new Set(
      execute(workflow, github)
        .filter((r) => COVERAGE.test(r.script))
        .map((r) => r.job),
    ),
  ]
}

const truthyText = (v: unknown): boolean => {
  if (v === undefined || v === null) return false
  return holds(text(v), { github: {}, matrix: {}, inputs: {}, vars: {}, secrets: {}, env: {} })
}

describe('AC-4: coverage runs nightly, not on a push', () => {
  it('AC-4: no ci.yml job runs coverage on a push to dev or main, or on a dispatch', () => {
    const ci = loadWorkflow(WORKFLOW)
    const found = [DEV_PUSH, MAIN_PUSH, DEV_DISPATCH].flatMap((github) =>
      coverageJobs(ci, github).map((id) => `${github.event_name} on ${github.ref_name}: ${id}`),
    )
    expect(found).toEqual([])
  })

  it('AC-4: one nightly.yml job runs coverage on a dispatch on dev: continue-on-error, needing build, the artefact downloaded before the run', () => {
    const nightly = loadWorkflow(NIGHTLY)
    const ids = coverageJobs(nightly, nightlyDispatch('dev', 'f'))
    const shape = ids.map((id) => {
      const job = nightly.jobs[id]!
      const steps = job.steps ?? []
      const download = steps.findIndex(
        (s) => s.uses?.startsWith('actions/download-artifact@') && s.with?.name === 'build-output',
      )
      const run = steps.findIndex((s) => typeof s.run === 'string' && COVERAGE.test(s.run))
      return {
        job: id,
        continueOnError: truthyText(job['continue-on-error']),
        needsBuild: needsOf(job).includes('build'),
        artefactFirst: download !== -1 && download < run,
      }
    })
    expect(shape).toEqual([
      { job: ids[0], continueOnError: true, needsBuild: true, artefactFirst: true },
    ])
  })
})

type Recorded = { argv: string[]; token: string; repoKnown: boolean }

/**
 * Runs a step's script under bash with a `gh` on PATH that records, call by call, its arguments, token and
 * repository. The script's exit status, and every `gh` call in the order made.
 */
function runWithGh(
  run: Executed,
  repository: string,
  checkedOut: boolean,
): { status: number; calls: Recorded[] } {
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-gh-stub-'))
  scratchDirs.push(dir)
  const calls = join(dir, 'calls')
  mkdirSync(calls)
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/usr/bin/env bash',
      `n=$(ls "${calls}" | wc -l | tr -d ' ')`,
      `mkdir "${calls}/$n"`,
      `printf '%s\\n' "$@" >"${calls}/$n/argv"`,
      `printf '%s' "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}" >"${calls}/$n/token"`,
      `printf '%s' "\${GH_REPO:-}" >"${calls}/$n/repo"`,
      '',
    ].join('\n'),
  )
  chmodSync(join(dir, 'gh'), 0o755)
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run.script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...run.env, HOME: dir, PATH: `${dir}:/usr/bin:/bin` },
  })
  const read = (call: string, name: string): string => {
    try {
      return readFileSync(join(calls, call, name), 'utf8')
    } catch {
      return ''
    }
  }
  const recorded = readdirSync(calls)
    .sort((a, b) => Number(a) - Number(b))
    .map((call) => {
      const argv = read(call, 'argv').split('\n').slice(0, -1)
      let repo = read(call, 'repo')
      const kept: string[] = []
      for (let k = 0; k < argv.length; k += 1) {
        const arg = argv[k]!
        if (arg === '--repo' || arg === '-R') repo = argv[(k += 1)] ?? ''
        else if (arg.startsWith('--repo=')) repo = arg.slice('--repo='.length)
        else kept.push(arg)
      }
      return {
        argv: kept,
        token: read(call, 'token'),
        repoKnown: repo === repository || (repo === '' && checkedOut),
      }
    })
  return { status: r.status ?? -1, calls: recorded }
}

const scratchDirs: string[] = []
afterAll(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("AC-5: the nightly is dev's, by dispatch", () => {
  it('AC-5: nightly.yml runs on workflow_dispatch alone, and its run-name names the branch it was dispatched on', () => {
    const nightly = loadWorkflow(NIGHTLY)
    const branches = ['dev', 'main']
    expect({
      events: eventsOf(nightly),
      names: branches.map((b) =>
        substitute(text(nightly['run-name']), { github: nightlyDispatch(b, 'f') }),
      ),
    }).toEqual({ events: ['workflow_dispatch'], names: branches.map((b) => `Nightly on ${b}`) })
  })

  it("AC-6: nightly-trigger.yml runs on the 03:00 schedule alone, and dispatches dev's nightly.yml then dev's registry.yml, both with the GITHUB_TOKEN", () => {
    const trigger = loadWorkflow(NIGHTLY_TRIGGER)
    const token = 'ghs_fixture-token'
    const github = {
      event_name: 'schedule',
      base_ref: '',
      ref: 'refs/heads/main',
      ref_name: 'main',
      sha: sha('e'),
      repository: 'nymbalhq/nymbal',
      token,
      event: { schedule: '0 3 * * *' },
    }
    const runs = execute(trigger, github, { secrets: { GITHUB_TOKEN: token } })
    const schedule = (trigger.on as { schedule?: Array<{ cron?: string }> } | undefined)?.schedule
    const stepsRun = runs.map((r) =>
      runWithGh(
        r,
        github.repository,
        (trigger.jobs[r.job]?.steps ?? []).some((s) => s.uses?.startsWith('actions/checkout@')),
      ),
    )
    expect({
      events: eventsOf(trigger),
      crons: (schedule ?? []).map((s) => s.cron),
      actions: [
        ...new Set(
          runs.map((r) => (trigger.jobs[r.job]?.permissions ?? trigger.permissions)?.actions),
        ),
      ],
      failed: stepsRun.filter((s) => s.status !== 0).length,
      dispatched: stepsRun.flatMap((s) => s.calls),
    }).toEqual({
      events: ['schedule'],
      crons: ['0 3 * * *'],
      actions: ['write'],
      failed: 0,
      dispatched: ['nightly.yml', 'registry.yml'].map((workflow) => ({
        argv: ['workflow', 'run', workflow, '--ref', 'dev'],
        token,
        repoKnown: true,
      })),
    })
  })

  // Only these never brake a merge: the quarantined tests and the mobile E2E (non-blocking by the harness's own
  // rules), and coverage, which moves from ci.yml as it was.
  it('AC-5: in nightly.yml, quarantine, e2e-full and the coverage job continue on error, and no other job or step does', () => {
    const nightly = loadWorkflow(NIGHTLY)
    const lenient = Object.entries(nightly.jobs)
      .flatMap(([id, job]) =>
        truthyText(job['continue-on-error'])
          ? [id]
          : (job.steps ?? []).flatMap((s, i) =>
              truthyText(s['continue-on-error']) ? [`${id} (step ${i})`] : [],
            ),
      )
      .sort()
    expect(lenient).toEqual(
      ['e2e-full', 'quarantine', ...coverageJobs(nightly, nightlyDispatch('dev', 'f'))].sort(),
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The registry nightly installs and certifies adapters nobody here wrote, so its job holds nothing their code could
// use: no write permission, no secret, no persisted token, and no cache a job holding secrets would restore. Its one
// saved cache is the status history, carried from night to night so the 7-day clock runs.
// ---------------------------------------------------------------------------------------------------------------

const REGISTRY = fileURLToPath(new URL('../../.github/workflows/registry.yml', import.meta.url))
const REGISTRY_RUN_ID = '4242'
const REGISTRY_DISPATCH: Ctx = {
  event_name: 'workflow_dispatch',
  base_ref: '',
  ref: 'refs/heads/dev',
  ref_name: 'dev',
  sha: sha('d'),
  repository: 'nymbalhq/nymbal',
  run_id: REGISTRY_RUN_ID,
  event: { inputs: {} },
}
const RUNNER_WORKSPACE = '/home/runner/work/nymbal/nymbal'
const RUNNER_TEMP = '/home/runner/work/_temp'

describe('AC-6: the registry workflow', () => {
  it('AC-6: registry.yml runs on workflow_dispatch alone, in one job holding contents: read and nothing else, with a timeout, no secret, a checkout that keeps no token, and no setup-node or actions/cache@ cache', () => {
    const workflow = loadWorkflow(REGISTRY)
    const jobs = Object.values(workflow.jobs)
    const steps = jobs.flatMap((j) => j.steps ?? [])
    const using = (prefix: string) => steps.filter((s) => s.uses?.startsWith(prefix) === true)

    expect({
      events: eventsOf(workflow),
      permissions: jobs.map((j) => j.permissions ?? workflow.permissions ?? null),
      timeouts: jobs.map((j) => text((j as { 'timeout-minutes'?: Yaml })['timeout-minutes'])),
      secrets: JSON.stringify(workflow).match(/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/g) ?? [],
      checkouts: using('actions/checkout@').map((s) => text(s.with?.['persist-credentials'])),
      setupNodeCaches: using('actions/setup-node@').flatMap((s) =>
        s.with?.['cache'] === undefined ? [] : [s.with['cache']],
      ),
      cacheSaveAndRestore: using('actions/cache@').map((s) => s.uses),
    }).toEqual({
      events: ['workflow_dispatch'],
      permissions: [{ contents: 'read' }],
      timeouts: ['90'],
      secrets: [],
      checkouts: ['false'],
      setupNodeCaches: [],
      cacheSaveAndRestore: [],
    })
  })

  it("AC-6: registry.yml restores last night's history to the file pnpm registry reads on registry/adapters.json, saves only that file as registry-history-<run id> after the run, and uploads the run's output as registry-site", () => {
    const workflow = loadWorkflow(REGISTRY)
    const [jobId, job] = Object.entries(workflow.jobs)[0] ?? ['', { steps: [] } as Job]
    const steps = job.steps ?? []
    const base: Ctx = {
      github: REGISTRY_DISPATCH,
      matrix: {},
      inputs: {},
      vars: {},
      secrets: {},
      runner: { os: 'Linux', temp: RUNNER_TEMP },
      steps: {},
    }
    const wfEnv = layer(workflow.env, { ...base, env: {} })
    const jobEnv = { ...wfEnv, ...layer(job.env, { ...base, env: wfEnv }) }
    const withOf = (step: Step, key: string): string => {
      try {
        return substitute(text(step.with?.[key]), { ...base, env: jobEnv }).trim()
      } catch {
        return ''
      }
    }

    // Every run step under bash in a stand-in workspace, with a `pnpm` on PATH that records the step and its words.
    const dir = mkdtempSync(join(tmpdir(), 'nymbal-registry-wf-'))
    scratchDirs.push(dir)
    const ws = join(dir, 'ws')
    const bin = join(dir, 'bin')
    const calls = join(dir, 'calls')
    for (const d of [ws, bin, calls]) mkdirSync(d)
    writeFileSync(
      join(bin, 'pnpm'),
      [
        '#!/usr/bin/env bash',
        `n=$(ls "${calls}" | wc -l | tr -d ' ')`,
        `printf '%s\\n' "$REGISTRY_STEP" "$@" >"${calls}/$n"`,
        '',
      ].join('\n'),
    )
    chmodSync(join(bin, 'pnpm'), 0o755)
    for (const [i, step] of steps.entries()) {
      if (typeof step.run !== 'string') continue
      const env = { ...jobEnv, ...layer(step.env, { ...base, env: jobEnv }) }
      let runs = true
      try {
        runs = holds(step.if, { ...base, env })
      } catch {
        // A status function the evaluator does not know: on a night with no failure the step runs.
      }
      if (!runs) continue
      spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-eo',
          'pipefail',
          '-c',
          substitute(step.run.replace(/\\\n/g, ' '), { ...base, env }),
        ],
        {
          cwd: ws,
          encoding: 'utf8',
          env: {
            ...env,
            REGISTRY_STEP: String(i),
            GITHUB_WORKSPACE: ws,
            GITHUB_RUN_ID: REGISTRY_RUN_ID,
            RUNNER_TEMP,
            HOME: dir,
            PATH: `${bin}:/usr/bin:/bin`,
          },
        },
      )
    }
    const registryCalls = readdirSync(calls)
      .sort((a, b) => Number(a) - Number(b))
      .map((f) => readFileSync(join(calls, f), 'utf8').split('\n').slice(0, -1))
      .map(([step, ...args]) => {
        const words = args.filter((a) => a !== '--silent' && a !== '-s')
        return { step: Number(step), args: words[0] === 'run' ? words.slice(1) : words }
      })
      .filter((c) => c.args[0] === 'registry')
    const call = registryCalls[0] ?? { step: -1, args: [] }
    // A path as the runner sees it: relative to the workspace, which the stand-in replaces.
    const onRunner = (p: string | undefined): string =>
      p === undefined
        ? ''
        : resolve(
            RUNNER_WORKSPACE,
            p.startsWith(ws) ? `${RUNNER_WORKSPACE}${p.slice(ws.length)}` : p,
          )
    const history = onRunner(flag(call.args, '--history'))
    const out = onRunner(flag(call.args, '--out'))
    const lastNight = `registry-history-${Number(REGISTRY_RUN_ID) - 1}`
    const indexed = steps.map((s, i) => ({ s, i }))
    const historyRestores = indexed
      .filter(({ s }) => s.uses?.startsWith('actions/cache/restore@') === true)
      .map(({ s, i }) => ({
        i,
        path: onRunner(withOf(s, 'path')),
        candidates: [withOf(s, 'key'), ...withOf(s, 'restore-keys').split('\n')]
          .map((c) => c.trim())
          .filter(Boolean),
      }))
      .filter((r) => r.candidates.some((c) => c.startsWith('registry-history-')))

    expect({
      job: jobId === '' ? 'none' : 'one',
      registryCalls: registryCalls.length,
      manifest: onRunner(flag(call.args, '--manifest')),
      restored: historyRestores.map((r) => ({
        path: r.path,
        beforeRun: r.i < call.step,
        findsLastNight: r.candidates.some((c) => lastNight.startsWith(c)),
      })),
      saved: indexed
        .filter(({ s }) => s.uses?.startsWith('actions/cache/save@') === true)
        .map(({ s, i }) => ({
          key: withOf(s, 'key'),
          path: onRunner(withOf(s, 'path')),
          afterRun: i > call.step,
        })),
      uploaded: indexed
        .filter(
          ({ s }) =>
            s.uses?.startsWith('actions/upload-artifact@') === true &&
            withOf(s, 'name') === 'registry-site',
        )
        .map(({ s }) => onRunner(withOf(s, 'path'))),
    }).toEqual({
      job: 'one',
      registryCalls: 1,
      manifest: resolve(RUNNER_WORKSPACE, 'registry/adapters.json'),
      restored: [{ path: history, beforeRun: true, findsLastNight: true }],
      saved: [{ key: `registry-history-${REGISTRY_RUN_ID}`, path: history, afterRun: true }],
      uploaded: [out],
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-9: the browser cache. The key is evaluated as the runner would: the steps before the cache step that set an
// output run under bash in a scratch holding only the lockfile and the package manifests, and hashFiles() hashes the
// scratch's files. It must move with the runner OS and with the Playwright version, and stay put when another
// package moves, so a Playwright bump never restores old browsers and a routine bump keeps the cache.
// ---------------------------------------------------------------------------------------------------------------

const PLAYWRIGHT_INSTALL = /\bplaywright\s+install(?:-deps)?\b/
const BROWSER_CACHE = '~/.cache/ms-playwright'
const LOCKFILE = readFileSync(join(REPO, 'pnpm-lock.yaml'), 'utf8')
const PLAYWRIGHT_VERSION = /'@playwright\/test@(\d+\.\d+\.\d+)'/.exec(LOCKFILE)?.[1] ?? ''
const MANIFESTS = ['package.json', 'pnpm-workspace.yaml', 'tests/e2e/package.json']

type Variant = { label: string; os: string; edit: (text: string) => string }
const VARIANTS: Variant[] = [
  { label: 'as committed', os: 'Linux', edit: (t) => t },
  { label: 'on macOS', os: 'macOS', edit: (t) => t },
  {
    label: 'with Playwright bumped',
    os: 'Linux',
    edit: (t) => t.replaceAll(PLAYWRIGHT_VERSION, '1.99.0'),
  },
  {
    label: 'with Vitest bumped',
    os: 'Linux',
    edit: (t) => t.replace(/(?<![\d.])3\.2\.4(?!\d)/g, '3.2.5'),
  },
]

/** Each `playwright install` or `install-deps` in a script, from the subcommand on. */
function playwrightInstalls(script: string): string[] {
  return [...script.matchAll(/\bplaywright\s+(install(?:-deps)?\b[^\n;&|]*)/g)].map((m) =>
    words(m[1]!).join(' '),
  )
}

function playwrightJobs(workflow: Workflow): string[] {
  return Object.keys(workflow.jobs).filter((id) =>
    runs(workflow.jobs[id]!).some((script) => PLAYWRIGHT_INSTALL.test(script)),
  )
}

function browserCache(job: Job): { index: number; step: Step } | undefined {
  const steps = job.steps ?? []
  const index = steps.findIndex(
    (s) =>
      /^actions\/cache(?:\/restore)?@/.test(s.uses ?? '') &&
      text(s.with?.path)
        .split('\n')
        .map((p) => p.trim())
        .includes(BROWSER_CACHE),
  )
  return index === -1 ? undefined : { index, step: steps[index]! }
}

const variantDirs = new Map<string, string>()
function variantDir(variant: Variant): string {
  const known = variantDirs.get(variant.label)
  if (known !== undefined) return known
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-browser-cache-'))
  scratchDirs.push(dir)
  for (const file of ['pnpm-lock.yaml', ...MANIFESTS]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), variant.edit(readFileSync(join(REPO, file), 'utf8')))
  }
  variantDirs.set(variant.label, dir)
  return dir
}

function hashFilesIn(dir: string, patterns: string[]): string {
  const files = ['pnpm-lock.yaml', ...MANIFESTS]
  const matched = files.filter((f) =>
    patterns.some((p) =>
      p.startsWith('**/') ? f === p.slice(3) || f.endsWith(`/${p.slice(3)}`) : f === p,
    ),
  )
  if (matched.length === 0) return ''
  const hash = createHash('sha256')
  for (const f of matched.sort()) hash.update(readFileSync(join(dir, f)))
  return hash.digest('hex')
}

const outputsRun = new Map<string, Record<string, string>>()
/** The outputs a step's script writes to $GITHUB_OUTPUT, run in a variant's scratch. */
function stepOutputs(
  script: string,
  env: Record<string, string>,
  variant: Variant,
): Record<string, string> {
  const key = `${variant.label}\n${script}`
  const known = outputsRun.get(key)
  if (known !== undefined) return known
  const dir = variantDir(variant)
  const output = join(mkdtempSync(join(tmpdir(), 'nymbal-step-output-')), 'out')
  scratchDirs.push(dirname(output))
  writeFileSync(output, '')
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      ...env,
      RUNNER_OS: variant.os,
      GITHUB_OUTPUT: output,
    },
  })
  if (r.status !== 0) {
    throw new Error(
      `a step before the cache failed in a scratch holding the lockfile and manifests: ${r.stderr}`,
    )
  }
  const out: Record<string, string> = {}
  const lines = readFileSync(output, 'utf8').split('\n')
  for (let k = 0; k < lines.length; k += 1) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[k]!)
    if (heredoc !== null) {
      const body: string[] = []
      while (k + 1 < lines.length && lines[k + 1] !== heredoc[2]) body.push(lines[(k += 1)]!)
      k += 1
      out[heredoc[1]!] = body.join('\n')
    } else {
      const eq = lines[k]!.indexOf('=')
      if (eq > 0) out[lines[k]!.slice(0, eq)] = lines[k]!.slice(eq + 1)
    }
  }
  outputsRun.set(key, out)
  return out
}

/** The browser cache's key for a job, as a variant's runner and files make it. */
function browserCacheKey(workflow: Workflow, id: string, github: Ctx, variant: Variant): string {
  const job = workflow.jobs[id]!
  const cache = browserCache(job)!
  const base: Ctx = {
    github,
    matrix: combinations(job)[0]!,
    inputs: {},
    vars: {},
    secrets: {},
    runner: { os: variant.os },
  }
  const steps: Record<string, { outputs: Record<string, string> }> = {}
  const wfEnv = layer(workflow.env, { ...base, steps, env: {} })
  const jobEnv = { ...wfEnv, ...layer(job.env, { ...base, steps, env: wfEnv }) }
  const envOf = (step: Step): Record<string, string> => ({
    ...jobEnv,
    ...layer(step.env, { ...base, steps, env: jobEnv }),
  })
  for (const step of (job.steps ?? []).slice(0, cache.index)) {
    const ctx = { ...base, steps, env: envOf(step) }
    if (step.id === undefined || typeof step.run !== 'string' || !holds(step.if, ctx)) continue
    steps[step.id] = { outputs: stepOutputs(substitute(step.run, ctx), ctx.env, variant) }
  }
  return substitute(text(cache.step.with?.key), {
    ...base,
    steps,
    env: envOf(cache.step),
    hashFiles: (patterns: string[]) => hashFilesIn(variantDir(variant), patterns),
  })
}

const PLAYWRIGHT_WORKFLOWS: Array<{ file: string; github: Ctx }> = [
  { file: WORKFLOW, github: DEV_PUSH },
  { file: NIGHTLY, github: nightlyDispatch('dev', 'f') },
]

describe('AC-9: every Playwright job caches its browsers', () => {
  it('AC-9: every job that installs Playwright restores ~/.cache/ms-playwright first, keyed on the runner OS and the Playwright version in the lockfile', () => {
    expect(PLAYWRIGHT_VERSION, 'the lockfile pins @playwright/test').toMatch(/^\d+\.\d+\.\d+$/)
    const outcomes: string[] = []
    const expected: string[] = []
    for (const { file, github } of PLAYWRIGHT_WORKFLOWS) {
      const workflow = loadWorkflow(file)
      for (const id of playwrightJobs(workflow)) {
        const name = `${basename(file)} ${id}`
        const good = `${name}: restored before the install; the key moves with the OS and Playwright, not with Vitest`
        expected.push(good)
        const job = workflow.jobs[id]!
        const cache = browserCache(job)
        const install = (job.steps ?? []).findIndex(
          (s) => typeof s.run === 'string' && PLAYWRIGHT_INSTALL.test(s.run),
        )
        if (cache === undefined || cache.index > install) {
          outcomes.push(`${name}: no ${BROWSER_CACHE} cache step before its first install`)
          continue
        }
        const [linux, mac, bumped, other] = VARIANTS.map((v) =>
          browserCacheKey(workflow, id, github, v),
        )
        outcomes.push(
          linux !== '' && linux !== mac && linux !== bumped && linux === other
            ? good
            : `${name}: key "${linux}", on macOS "${mac}", Playwright bumped "${bumped}", Vitest bumped "${other}"`,
        )
      }
    }
    expect(expected.length, 'jobs that install Playwright').toBeGreaterThanOrEqual(13)
    expect(outcomes).toEqual(expected)
  })

  it('AC-9: on a cache hit each of those jobs installs only the system libraries, and on a miss the browsers with them', () => {
    const outcomes: string[] = []
    const expected: string[] = []
    for (const { file, github } of PLAYWRIGHT_WORKFLOWS) {
      const workflow = loadWorkflow(file)
      for (const id of playwrightJobs(workflow)) {
        const name = `${basename(file)} ${id}`
        expected.push(
          `${name}: hit [install-deps chromium]; restore-key hit [install --with-deps chromium]; miss [install --with-deps chromium]`,
        )
        const cacheId = browserCache(workflow.jobs[id]!)?.step.id
        if (cacheId === undefined) {
          outcomes.push(`${name}: no browser cache step with an id, so no step reads its hit`)
          continue
        }
        const installs = (hit: string): string => {
          const executed = execute(workflow, github, {
            steps: { [cacheId]: { outputs: { 'cache-hit': hit } } },
          }).filter((r) => r.job === id)
          return `[${[...new Set(executed.flatMap((r) => playwrightInstalls(r.script)))].join(', ')}]`
        }
        outcomes.push(
          `${name}: hit ${installs('true')}; restore-key hit ${installs('false')}; miss ${installs('')}`,
        )
      }
    }
    expect(outcomes).toEqual(expected)
  })
})

describe('dev CI runs the harness projects whatever changed', () => {
  it('the gate.ts call whose --only names tests passes --harness all, and its plan negates no harness project', () => {
    const calls = gateCalls(loadWorkflow(WORKFLOW), DEV_PUSH).filter((c) =>
      (flag(c.args, '--only') ?? '')
        .split(',')
        .map((n) => n.trim())
        .includes('tests'),
    )
    expect(calls.length, 'a job runs the tests step').toBeGreaterThan(0)
    for (const call of calls) {
      expect(flag(call.args, '--harness'), call.job).toBe('all')
      const tests = plan({
        full: true,
        base: 'HEAD',
        changed: ['packages/sdk/src/client.ts'],
        mutated: [],
        only: (flag(call.args, '--only') ?? '').split(',').map((n) => n.trim()),
        harness: 'all',
      }).steps.find((s) => s.name === 'tests')
      expect(leftOut(tests?.command ?? '', HARNESS_PROJECTS)).toEqual([])
    }
  })
})

// The gate's tests step split over a matrix of shards: every shard runs the same tests call but for its `--shard`,
// and shard 1 alone runs lint, typecheck and census trend besides, so each step runs once per push and every test
// file in one shard.
const SHARDED_JOB = 'gate-tests'

type ShardCall = { shard: string; args: string[] }

/** The gate.ts calls each combination of a job runs on an event, by the combination's `shard`. */
function shardCalls(workflow: Workflow, github: Ctx, id: string): ShardCall[] {
  return execute(workflow, github)
    .filter((run) => run.job === id)
    .flatMap((run) =>
      [...run.script.matchAll(/scripts\/gate\.ts([^\n;&|]*)/g)].map((m) => ({
        shard: run.matrix.shard ?? '',
        args: words(m[1] ?? '').map((w) => expand(w, run, m.index)),
      })),
    )
}

const onlyOf = (args: string[]): string[] =>
  (flag(args, '--only') ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)

/** A call's `--shard` values, in either form, and its other arguments. */
function shardFlags(args: string[]): { values: string[]; rest: string[] } {
  const values: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--shard') {
      values.push(args[i + 1] ?? '')
      i += 1
    } else if (arg.startsWith('--shard=')) values.push(arg.slice('--shard='.length))
    else rest.push(arg)
  }
  return { values, rest }
}

/** The steps one combination of a job runs on an event: its `if` honoured, `with` values substituted. */
function stepsRun(
  workflow: Workflow,
  github: Ctx,
  id: string,
  matrix: Record<string, string>,
): Step[] {
  const job = workflow.jobs[id] ?? {}
  const base: Ctx = {
    github,
    matrix,
    inputs: {},
    vars: {},
    secrets: {},
    runner: { os: 'Linux' },
    steps: {},
  }
  const wfEnv = layer(workflow.env, { ...base, env: {} })
  const env = { ...wfEnv, ...layer(job.env, { ...base, env: wfEnv }) }
  return (job.steps ?? [])
    .filter((step) =>
      holds(step.if, { ...base, env: { ...env, ...layer(step.env, { ...base, env }) } }),
    )
    .map((step) =>
      step.with === undefined
        ? step
        : {
            ...step,
            with: Object.fromEntries(
              Object.entries(step.with).map(([k, v]) => [k, substitute(text(v), { ...base, env })]),
            ),
          },
    )
}

const bareCondition = (condition: string | undefined): string =>
  (condition ?? '').replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '').trim()

describe('AC-3: the workflow splits the Gate job without dropping a step', () => {
  it('AC-3: on a push to dev, gate-tests runs shards 1..N, each the same tests call but for --shard=i/N, and shard 1 alone runs lint, typecheck and census trend', () => {
    const ci = loadWorkflow(WORKFLOW)
    expect(Object.keys(ci.jobs), 'the single Gate job is gone').not.toContain('gate')
    const matrix = ci.jobs[SHARDED_JOB]?.strategy?.matrix?.['shard']
    const count = Array.isArray(matrix) ? matrix.length : 0
    const shards =
      ci.jobs[SHARDED_JOB] === undefined
        ? []
        : combinations(ci.jobs[SHARDED_JOB]).map((c) => c.shard ?? '')
    expect(
      shards.map(Number).sort((a, b) => a - b),
      'each shard index 1..N once, N the matrix length',
    ).toEqual(Array.from({ length: count }, (_, i) => i + 1))
    expect(count, 'a split runs more than one shard').toBeGreaterThan(1)

    const calls = shardCalls(ci, DEV_PUSH, SHARDED_JOB)
    const testCalls = calls.filter((c) => onlyOf(c.args).includes('tests'))
    expect(
      testCalls.map((c) => `${c.shard}: --shard ${shardFlags(c.args).values.join(' ')}`).sort(),
      'one tests call per shard, carrying its own i/N once',
    ).toEqual(shards.map((s) => `${s}: --shard ${s}/${count}`).sort())
    const rests = testCalls.map((c) => shardFlags(c.args).rest)
    expect(rests, 'the shard calls differ in --shard alone').toEqual(rests.map(() => rests[0]))
    const rest = rests[0] ?? []
    expect({
      full: rest.includes('--full'),
      only: flag(rest, '--only'),
      harness: flag(rest, '--harness'),
      noBuild: rest.includes('--no-build'),
      base: flag(rest, '--base'),
    }).toEqual({
      full: true,
      only: 'tests',
      harness: 'all',
      noBuild: true,
      base: DEV_PUSH.event.before,
    })

    expect(
      calls
        .filter((c) => !onlyOf(c.args).includes('tests'))
        .map((c) => `shard ${c.shard}: ${onlyOf(c.args).sort().join(',')}`),
      'the lint, typecheck and census trend call runs in shard 1 alone',
    ).toEqual(['shard 1: census trend,lint,typecheck'])
    const runsPerStep: Record<string, number> = {}
    for (const c of calls)
      for (const step of onlyOf(c.args)) runsPerStep[step] = (runsPerStep[step] ?? 0) + 1
    expect(runsPerStep, 'each step once per push, tests once per shard').toEqual({
      lint: 1,
      typecheck: 1,
      'census trend': 1,
      tests: count,
    })
  })
})

describe('AC-4: each shard uses the build artefact and full history', () => {
  it('AC-4: every gate-tests combination needs build, downloads build-output before its first gate.ts call, checks out with fetch-depth 0, and uploads reports/vitest.json as vitest-shard-<i> always, overwriting; the job keeps a timeout of at most 15 minutes and does not fail fast', () => {
    const ci = loadWorkflow(WORKFLOW)
    expect(Object.keys(ci.jobs)).toContain(SHARDED_JOB)
    const job = ci.jobs[SHARDED_JOB]!
    const built = artefactName(uploadsOf(ci.jobs.build ?? {})[0] ?? {})
    const shards = combinations(job).map((c) => c.shard ?? '')
    const rows = shards.map((shard) => {
      const steps = stepsRun(ci, DEV_PUSH, SHARDED_JOB, { shard })
      const download = steps.findIndex(
        (s) => s.uses?.startsWith('actions/download-artifact@') && s.with?.name === built,
      )
      const firstGate = steps.findIndex((s) => /scripts\/gate\.ts/.test(s.run ?? ''))
      const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'))
      const reports = steps.filter(
        (s) =>
          s.uses?.startsWith('actions/upload-artifact@') &&
          (s.with?.path ?? '')
            .split('\n')
            .map((p) => p.trim())
            .includes('reports/vitest.json'),
      )
      return {
        shard,
        needsBuild: needsOf(job).includes('build'),
        downloadsBeforeGate: download !== -1 && firstGate !== -1 && download < firstGate,
        fetchDepth: text(checkout?.with?.['fetch-depth']),
        reports: reports.map((s) => ({
          name: s.with?.name,
          if: bareCondition(s.if),
          overwrite: text(s.with?.['overwrite']),
        })),
      }
    })
    expect(rows).toEqual(
      shards.map((shard) => ({
        shard,
        needsBuild: true,
        downloadsBeforeGate: true,
        fetchDepth: '0',
        reports: [{ name: `vitest-shard-${shard}`, if: 'always()', overwrite: 'true' }],
      })),
    )
    const timeout = Number(text((job as { 'timeout-minutes'?: Yaml })['timeout-minutes']))
    expect(timeout).toBeLessThanOrEqual(15)
    expect(text((job.strategy as Record<string, Yaml> | undefined)?.['fail-fast'])).toBe('false')
  })
})

// The command line alone decides whether CI's sentinels and mutation jobs run their step, and whether the ratchet
// blocks: a gate.ts call naming either step must plan it to run, and the mutation step must block.
describe('dev CI asks for the sentinels and stryker steps it names, and the mutation job blocks', () => {
  const named = (call: GateCall): string[] =>
    (flag(call.args, '--only') ?? '').split(',').map((n) => n.trim())

  const modesOf = (call: GateCall): ReturnType<typeof stepModes> =>
    stepModes({
      only: named(call),
      sentinels: flag(call.args, '--sentinels'),
      stryker: call.args.includes('--stryker'),
    })
  const naming = (step: string): GateCall[] =>
    gateCalls(loadWorkflow(WORKFLOW), DEV_PUSH).filter((c) => named(c).includes(step))

  it('the calls naming stryker block on the ratchet, and those naming sentinels run them', () => {
    const stryker = naming('stryker')
    const sentinels = naming('sentinels')
    expect(stryker.length, 'ci.yml runs stryker on a push to dev').toBeGreaterThan(0)
    expect(sentinels.length, 'ci.yml runs the sentinels on a push to dev').toBeGreaterThan(0)
    expect(stryker.map((c) => [c.job, modesOf(c).stryker])).toEqual(
      stryker.map((c) => [c.job, 'blocking']),
    )
    expect(sentinels.filter((c) => modesOf(c).sentinels === 'none').map((c) => c.job)).toEqual([])
  })

  it('every gate.ts call whose --only names sentinels or stryker plans that step to run, the ratchet chained', () => {
    const calls = [...naming('sentinels'), ...naming('stryker')]
    for (const call of calls) {
      const modes = modesOf(call)
      const planned = plan({
        full: true,
        base: 'HEAD',
        changed: ['packages/platform/src/services/cart-service.ts'],
        mutated: ['packages/platform/src/services/cart-service.ts'],
        only: named(call),
        services: flag(call.args, '--services') === 'external' ? 'external' : 'compose',
        postgresUrl: 'postgres://ci@localhost:5432/ci',
        mailpitUrl: 'http://localhost:8025',
        noBuild: call.args.includes('--no-build'),
        artefactPresent: true,
        sentinels: Array.isArray(modes.sentinels) ? new Set(modes.sentinels) : modes.sentinels,
        stryker: modes.stryker,
      }).steps
      for (const name of named(call).filter((n) => n === 'sentinels' || n === 'stryker')) {
        const found = planned.find((s) => s.name === name)
        expect(found, `${call.job}: ${name} is planned`).toBeDefined()
        expect(found?.skip, `${call.job}: ${name} runs`).toBeUndefined()
      }
    }
    for (const call of naming('stryker')) {
      const command =
        plan({
          full: true,
          base: 'HEAD',
          changed: ['packages/platform/src/services/cart-service.ts'],
          mutated: ['packages/platform/src/services/cart-service.ts'],
          only: named(call),
          stryker: modesOf(call).stryker,
        }).steps.find((s) => s.name === 'stryker')?.command ?? ''
      expect(command, `${call.job}: the ratchet blocks`).toMatch(
        /&& pnpm --silent mutation:ratchet check --report \S+$/,
      )
    }
  })
})

// Each nightly mutation run is held to its own ratchet. The check step's `run`, as the simulated event executes it,
// runs in a scratch holding the job's Stryker config, its ratchet, and a fixture report where that config writes its
// report. The other ratchet holds the file at 0, so a check aimed at it never fails.

const MUTATION_JOBS = [
  {
    job: 'mutation-full',
    config: 'stryker.config.mjs',
    ratchet: 'mutation-ratchet.json',
    other: 'mutation-ratchet.integration.json',
    stryker: /\bpnpm mutation --force\b/,
  },
  {
    job: 'mutation-integration',
    config: 'stryker.integration.config.mjs',
    ratchet: 'mutation-ratchet.integration.json',
    other: 'mutation-ratchet.json',
    stryker: /\bpnpm mutation:integration\b/,
  },
]
type MutationJob = (typeof MUTATION_JOBS)[number]

/** In both mutate sets; the fixture report scores it 50.00 (two of four mutants detected). */
const SCORED = 'packages/platform/src/services/alert-service.ts'
const SCORE = 50
const RATCHET_CHECK = /\bmutation:ratchet\s+check\b/

async function reportPathOf(config: string): Promise<string> {
  const loaded = (await import(pathToFileURL(join(REPO, config)).href)) as {
    default: { jsonReporter?: { fileName?: string } }
  }
  return loaded.default.jsonReporter?.fileName ?? 'reports/mutation/mutation.json'
}

function scoredReport(): unknown {
  const statuses = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Ignored']
  return {
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    files: {
      [SCORED]: {
        language: 'typescript',
        source: '',
        mutants: statuses.map((status, i) => ({
          id: String(i),
          mutatorName: 'BlockStatement',
          replacement: '{}',
          status,
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        })),
      },
    },
  }
}

/** Runs a check step's script as the runner's bash would, in a scratch where the job's ratchet holds SCORED at `entry`. */
async function runCheck(
  run: Executed,
  spec: MutationJob,
  entry: number,
): Promise<{ status: number; output: string }> {
  const ratchet = (score: number): string =>
    `${JSON.stringify({ measuredAt: '2026-10-01T00:00:00.000Z', command: 'fixture', total: 50, files: { [SCORED]: score } }, null, 2)}\n`
  const scripts = (
    JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
  const { root } = scratchRepo(
    {
      'package.json': JSON.stringify({
        name: 'nightly-check-scratch',
        private: true,
        type: 'module',
        scripts,
      }),
      'stryker.config.mjs': readFileSync(join(REPO, 'stryker.config.mjs'), 'utf8'),
      'stryker.integration.config.mjs': readFileSync(
        join(REPO, 'stryker.integration.config.mjs'),
        'utf8',
      ),
      [SCORED]: 'export const alert = 1\n',
      [spec.ratchet]: ratchet(entry),
      [spec.other]: ratchet(0),
    },
    { realModules: true },
  )
  // A copy, not the scratch's link: the CLI runs its main only when invoked by its real path.
  rmSync(join(root, 'scripts'))
  cpSync(join(REPO, 'scripts'), join(root, 'scripts'), { recursive: true })
  const reportPath = join(root, await reportPathOf(spec.config))
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(scoredReport()))
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run.script], {
    cwd: root,
    encoding: 'utf8',
    env: childEnv({ ...run.env, GATE_BASE: '' }),
  })
  return { status: r.status ?? -1, output: `${r.stdout}\n${r.stderr}` }
}

describe('AC-6: each nightly mutation job fails on a file below its own ratchet', () => {
  afterEach(cleanupScratch)

  it.each(NIGHTLY_EVENTS)(
    "AC-6: on $label, each mutation job's ratchet check exits 1 naming a file 0.01 below its entry, and 0 at its entry",
    async ({ github }) => {
      const executed = execute(loadWorkflow(NIGHTLY), github)
      const below = SCORE + 0.01
      const outcomes = await Promise.all(
        MUTATION_JOBS.flatMap((spec) => {
          const checks = executed.filter((r) => r.job === spec.job && RATCHET_CHECK.test(r.script))
          if (checks.length !== 1) {
            return [Promise.resolve(`${spec.job}: ${checks.length} ratchet check steps run`)]
          }
          return [below, SCORE].map(async (entry) => {
            const { status, output } = await runCheck(checks[0]!, spec, entry)
            const names =
              entry > SCORE ? (output.includes(SCORED) ? ', names it' : ', unnamed') : ''
            return `${spec.job} at ${entry.toFixed(2)}: exit ${status}${names}`
          })
        }),
      )
      expect(outcomes).toEqual(
        MUTATION_JOBS.flatMap((spec) => [
          `${spec.job} at ${below.toFixed(2)}: exit 1, names it`,
          `${spec.job} at ${SCORE.toFixed(2)}: exit 0`,
        ]),
      )
    },
    120_000,
  )

  it('AC-6: both mutation jobs need build and use its artefact without rebuilding, check after Stryker, never continue on error, and always upload the report their config writes', async () => {
    const nightly = loadWorkflow(NIGHTLY)
    const problems: string[] = []
    for (const spec of MUTATION_JOBS) {
      const job = nightly.jobs[spec.job]
      if (job === undefined) {
        problems.push(`${spec.job}: no such job`)
        continue
      }
      const steps = job.steps ?? []
      if (!needsOf(job).includes('build')) problems.push(`${spec.job}: does not need build`)
      const download = steps.some(
        (s) => s.uses?.startsWith('actions/download-artifact@') && s.with?.name === 'build-output',
      )
      if (!download) problems.push(`${spec.job}: does not download build-output`)
      for (const script of runs(job).filter((r) => BUILD.test(r))) {
        problems.push(`${spec.job}: rebuilds (${script})`)
      }
      const at = (re: RegExp): number =>
        steps.findIndex((s) => typeof s.run === 'string' && re.test(s.run))
      const stryker = at(spec.stryker)
      const check = at(RATCHET_CHECK)
      if (stryker === -1) problems.push(`${spec.job}: runs no ${spec.stryker.source}`)
      if (check <= stryker) {
        problems.push(
          `${spec.job}: the ratchet check (step ${check}) does not follow Stryker (step ${stryker})`,
        )
      }
      for (const [where, value] of [
        ['the job', job] as const,
        ...steps.map((s, i) => [`step ${i}`, s] as const),
      ]) {
        if (Object.hasOwn(value, 'continue-on-error')) {
          problems.push(`${spec.job}: ${where} has continue-on-error`)
        }
      }
      let reportDir: string
      try {
        reportDir = dirname(await reportPathOf(spec.config))
      } catch (error) {
        problems.push(`${spec.job}: ${spec.config} does not load (${String(error)})`)
        continue
      }
      const upload = uploadsOf(job).find((u) =>
        (u.with?.path ?? '')
          .split('\n')
          .map((p) => p.trim())
          .includes(reportDir),
      )
      if (upload === undefined) problems.push(`${spec.job}: uploads no ${reportDir}`)
      else if ((upload.if ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim() !== 'always()') {
        problems.push(`${spec.job}: the report upload runs ${upload.if ?? 'on success only'}`)
      }
    }
    expect(problems).toEqual([])
  })
})
