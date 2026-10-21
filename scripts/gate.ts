import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadSentinels, type Sentinel, touchedPaths } from './sentinels'
import {
  acquireExclusive,
  acquireShared,
  composePorts,
  type Hold,
  QUIET_MAX_WAIT_MS,
  type StackBlock,
  stack,
  stackBlock,
} from './stack'
import {
  aggregate,
  classifySource,
  EXCLUDED_PREFIXES,
  type FileCensus,
  journeyViolations,
  TEST_FILE,
  type Totals,
} from './test-census'

// The gate: one command to run before finishing (`pnpm gate`) and one before a pull request (`pnpm gate:full`).
// Every step is a shell command whose exit code decides its status; the verdict is red if and only if a step is
// red, and every step runs even after a red one (except those that need a step that is not ok).

export type StepStatus = 'ok' | 'red' | 'skipped'

export type Step = { name: string; status: StepStatus; ms: number; detail?: string }

/** A step to run. `skip` names the reason to leave it out; `needs` skips it unless every named step is ok. */
export type StepSpec = {
  name: string
  command: string
  skip?: string
  needs?: string[]
  /** The skip is because there is nothing for the step to do (not a precondition that failed). */
  idle?: boolean
  /** The quiet lock it holds while it runs: `shared` for a CPU-heavy step, `exclusive` for a timing-bound one. */
  hold?: 'shared' | 'exclusive'
}

export type RunOptions = {
  cwd: string
  budgetMs: number
  /** Progress and the output of red steps, as they happen. */
  log?: (text: string) => void
  env?: NodeJS.ProcessEnv
  /** How a step takes its hold; the quiet lock of `cwd`'s repository when not given. */
  acquire?: (mode: 'shared' | 'exclusive', label: string) => Promise<Hold>
}

export type RunResult = { exitCode: number; steps: Step[]; report: string }

export const GATE_BUDGET_MS = 60_000
export const FULL_BUDGET_MS = 600_000
const postgresUrl = (port: number): string => `postgres://postgres:nymbal@localhost:${port}/nymbal`
const mailpitUrl = (port: number): string => `http://localhost:${port}`
const redisUrl = (port: number): string => `redis://localhost:${port}`
/** The services compose.yaml publishes in stack slot 0. */
export const POSTGRES_URL = postgresUrl(stackBlock(0).postgres)
export const MAILPIT_URL = mailpitUrl(stackBlock(0).mailpitUi)
export const REDIS_URL = redisUrl(stackBlock(0).redis)
/** The MinIO API compose.yaml publishes, on NYMBAL_MINIO_PORT when it is moved. */
export const minioUrl = (port: string = '59000'): string => `http://localhost:${port}`

/**
 * The store sets the E2E suite runs on (`--stores`), as the variables the repo-root nymbal.config.ts reads. The first
 * is the default and needs no service.
 */
export const STORE_SETS = {
  'sqlite-memory': { commandStore: 'sqlite', documentStore: 'in-memory', eventBus: 'in-process' },
  'postgres-redis': { commandStore: 'postgres', documentStore: 'redis', eventBus: 'redis-streams' },
  'postgres-jsonb': {
    commandStore: 'postgres',
    documentStore: 'postgres-jsonb',
    eventBus: 'in-process',
  },
} as const
export type StoreSet = keyof typeof STORE_SETS

function usesRedis(set: { documentStore: string; eventBus: string }): boolean {
  return set.documentStore === 'redis' || set.eventBus === 'redis-streams'
}

export function storeSet(name: string): StoreSet {
  if (Object.hasOwn(STORE_SETS, name)) return name as StoreSet
  throw new Error(`--stores takes ${Object.keys(STORE_SETS).join(', ')}, not "${name}"`)
}

const ROOT_CONFIG_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'vitest.config.ts',
  'vitest.stryker.config.ts',
])

function isConfiguration(path: string): boolean {
  return (
    ROOT_CONFIG_FILES.has(path) ||
    /^(?:packages\/[^/]+\/)?tsconfig[^/]*\.json$/.test(path) ||
    /^packages\/[^/]+\/package\.json$/.test(path)
  )
}

function isDocumentation(path: string): boolean {
  return path.endsWith('.md') || path.startsWith('docs/')
}

/** Which tests a change set needs: all when configuration moved, none for documentation only, else the changed ones. */
export function selectTests(changed: string[]): {
  mode: 'all' | 'changed' | 'none'
  reason: string
} {
  const config = changed.find(isConfiguration)
  if (config !== undefined) return { mode: 'all', reason: `${config} changed` }
  if (changed.every(isDocumentation)) {
    return {
      mode: 'none',
      reason: changed.length === 0 ? 'nothing changed' : 'only documentation changed',
    }
  }
  return { mode: 'changed', reason: 'tests related to the changed files' }
}

/**
 * A file the build of a package reads: its source (tests aside), manifest, tsconfig or tsup config. Workspace packages
 * resolve one another through `dist`, so a change to one of these leaves every importer testing the old build.
 */
export function isBuildInput(path: string): boolean {
  if (TEST_FILE.test(path)) return false
  return /^packages\/[^/]+\/(?:src\/|package\.json$|tsup\.config\.[cm]?[jt]s$|tsconfig[^/]*\.json$)/.test(
    path,
  )
}

/**
 * `packages/<dir>` of `start` and every workspace package it depends on, directly or not, read from the manifests.
 * The proof kit's tests import these through `dist`, which `vitest --changed` cannot trace back to their source.
 */
export function workspaceClosure(root: string, start: string): string[] {
  const packages = resolve(root, 'packages')
  const dirByName = new Map<string, string>()
  const depsByDir = new Map<string, string[]>()
  for (const name of readdirSync(packages)) {
    const manifest = resolve(packages, name, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const dir = `packages/${name}`
    if (pkg.name !== undefined) dirByName.set(pkg.name, dir)
    depsByDir.set(dir, [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ])
  }
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const dir = queue.shift() as string
    if (seen.has(dir) || !depsByDir.has(dir)) continue
    seen.add(dir)
    for (const dep of depsByDir.get(dir) ?? []) {
      const next = dirByName.get(dep)
      if (next !== undefined) queue.push(next)
    }
  }
  return [...seen].sort()
}

/** Test files a sentinel's `# killed-by` and `# suite:` headers name. */
const NAMED_TEST_FILE =
  /\b(?:packages|tests|apps|templates)\/[\w./[\]-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/g

/** A change that can move every sentinel: configuration, the runner, or the sentinels themselves. */
function selectsEverySentinel(path: string): boolean {
  return (
    isConfiguration(path) || path === 'scripts/sentinels.ts' || path.startsWith('tests/sentinels/')
  )
}

/**
 * The sentinels a change can bear on: a changed file is a path the patch touches, a test file its headers name, or
 * inside the workspace closure (`closure(packages/<dir>)`) of a named file's package. Selection only grows with
 * `changed`. Package-level by design: every kernel change selects every kernel sentinel.
 */
export function selectSentinels(
  sentinels: Sentinel[],
  changed: string[],
  closure: (packageDir: string) => string[],
): Set<string> {
  if (changed.some(selectsEverySentinel)) return new Set(sentinels.map((s) => s.id))
  const selected = new Set<string>()
  for (const sentinel of sentinels) {
    const named = [...`${sentinel.killedBy} ${sentinel.suite ?? ''}`.matchAll(NAMED_TEST_FILE)].map(
      (m) => m[0],
    )
    const exact = new Set([...touchedPaths(sentinel.patch), ...named])
    const dirs = new Set(
      named.flatMap((path) => {
        const dir = /^packages\/[^/]+/.exec(path)?.[0]
        return dir === undefined ? [] : closure(dir)
      }),
    )
    const hit = (path: string): boolean =>
      exact.has(path) || [...dirs].some((dir) => path.startsWith(`${dir}/`))
    if (changed.some(hit)) selected.add(sentinel.id)
  }
  return selected
}

/** Rule 2 on the test files a change touches, and the census movement. Old debt in untouched files is ignored. */
export function censusTrend(
  base: FileCensus[],
  head: FileCensus[],
  touched: string[],
): { violations: string[]; delta: Totals } {
  const touchedSet = new Set(touched)
  const violations: string[] = []
  for (const file of head) {
    if (!touchedSet.has(file.path)) continue
    const { C1, C2, C3, C4, other } = file.assertions
    const total = C1 + C2 + C3 + C4 + other
    if (total > 0 && C2 + C3 === 0) {
      violations.push(
        `${file.path}: ${total} assertion(s), none relational (C3) or property-based (C2); rule 2 needs at least one`,
      )
    }
  }
  const before = aggregate(base).total
  const after = aggregate(head).total
  const delta = { ...after }
  for (const key of Object.keys(after) as Array<keyof Totals>) {
    delta[key] = after[key] - before[key]
  }
  return { violations, delta }
}

/** The added test files in a `git diff --name-status` listing. Renamed and copied files are not new. */
export function newTestFiles(nameStatus: string): string[] {
  const added: string[] = []
  for (const line of nameStatus.split('\n')) {
    const [status, path] = line.split('\t')
    if (status === 'A' && path !== undefined && TEST_FILE.test(path)) added.push(path)
  }
  return added
}

/**
 * A line that holds an assertion: an `expect` call (also `.soft` and `.poll`), a bare `assert(` or `assert.<x>(`,
 * `fc.assert(`, or a matcher that continues a multi-line `expect`, such as `).toBe(` or `.not.toEqual(`.
 */
const ASSERTION_LINE = [
  /\bexpect(?:\.soft|\.poll)?\(/,
  /(?<![\w.$])assert(?:\.\w+)?\(/,
  /\bfc\.assert\(/,
  /^\s*\)*\s*(?:\.(?:not|resolves|rejects))*\.to[A-Z]\w*\(/,
]

/** The path a `git diff` file section is about: where a rename went, else the new side of the file. */
function sectionPath(section: string[]): string | undefined {
  for (const line of section) {
    if (line.startsWith('@@')) break
    if (line.startsWith('rename to ')) return line.slice('rename to '.length)
    if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      return line.slice('+++ b/'.length).replace(/\t.*$/, '')
    }
  }
  return /^diff --git a\/.* b\/(.*)$/.exec(section[0] ?? '')?.[1]
}

/**
 * Whether the change touches assertions in `path`, from a unified `git diff -M` that may cover several files: the file
 * is new, or an added or removed line in its own hunks holds an assertion, so deleting or weakening one is judged as
 * much as writing one. Context lines, headers and other files' hunks never count, and a file that only moved is not
 * new.
 */
export function assertionTouched(diff: string, path: string): boolean {
  const sections: string[][] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) sections.push([])
    sections[sections.length - 1]?.push(line)
  }
  for (const section of sections) {
    if (sectionPath(section) !== path) continue
    let inHunk = false
    for (const line of section) {
      if (line.startsWith('@@')) {
        inHunk = true
      } else if (!inHunk) {
        if (line.startsWith('new file mode')) return true
      } else if (/^[+-]/.test(line)) {
        const content = line.slice(1)
        if (ASSERTION_LINE.some((shape) => shape.test(content))) return true
      }
    }
  }
  return false
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/** One row per step, then the verdict line. The verdict is computed from the steps, never from anything else. */
export function formatReport(steps: Step[], budgetMs: number): string {
  const total = steps.reduce((sum, step) => sum + step.ms, 0)
  const width = Math.max(0, ...steps.map((step) => step.name.length))
  const rows = steps.map((step) => {
    const detail = step.detail === undefined ? '' : `  ${step.detail.replaceAll('\n', ' ')}`
    return `${step.status.padEnd(7)} ${step.name.padEnd(width)}  ${seconds(step.ms).padStart(6)} s${detail}`
  })
  const red = steps.filter((step) => step.status === 'red').map((step) => step.name)
  const over = total > budgetMs ? ' over budget' : ''
  const verdict =
    red.length > 0
      ? `gate: RED (${red.join(', ')}) in ${seconds(total)} s${over}`
      : `gate: ok in ${seconds(total)} s (budget ${Number(seconds(budgetMs))} s)${over}`
  return [...rows, verdict].join('\n')
}

function tail(text: string, lines = 40): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

function execute(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', (error) => {
      resolvePromise({ code: 1, output: `${output}${error.message}` })
    })
    child.on('close', (code, signal) => {
      resolvePromise({ code: code ?? (signal === null ? 1 : 128), output })
    })
  })
}

/**
 * What a step's row says about its hold: an exclusive one always (proof runs quote the wait), a shared one only when
 * it waited past the bound and ran during another worktree's quiet. Its wait is not in the step's time.
 */
function holdNote(mode: 'shared' | 'exclusive', hold: Hold): string | undefined {
  const waited = `${seconds(hold.waitedMs)} s`
  if (mode === 'exclusive') {
    return hold.quiet ? `quiet after a ${waited} wait` : `ran without quiet after a ${waited} wait`
  }
  return hold.quiet ? undefined : `ran during another worktree's quiet after a ${waited} wait`
}

/** Runs the steps in order, each as a shell command in `cwd`; a red step does not stop the later ones. */
export async function run(steps: StepSpec[], opts: RunOptions): Promise<RunResult> {
  const results: Step[] = []
  const log = opts.log ?? ((): void => {})
  const acquire =
    opts.acquire ??
    ((mode: 'shared' | 'exclusive', label: string): Promise<Hold> =>
      mode === 'exclusive'
        ? acquireExclusive(opts.cwd, label, { maxWaitMs: QUIET_MAX_WAIT_MS })
        : acquireShared(opts.cwd, label, { maxWaitMs: QUIET_MAX_WAIT_MS }))
  for (const spec of steps) {
    const unmet = (spec.needs ?? []).flatMap((need) => {
      const earlier = results.find((s) => s.name === need)
      if (earlier === undefined) {
        throw new Error(`step "${spec.name}" needs "${need}", which is not an earlier step`)
      }
      return earlier.status === 'ok' ? [] : [`${need} (${earlier.status})`]
    })
    const reason = spec.skip ?? (unmet.length > 0 ? `needs ${unmet.join(', ')}` : undefined)
    if (reason !== undefined) {
      results.push({ name: spec.name, status: 'skipped', ms: 0, detail: reason })
      log(`skipped ${spec.name}: ${reason}\n`)
      continue
    }
    const mode = spec.hold
    const hold = mode === undefined ? undefined : await acquire(mode, spec.name)
    const quiet = mode === undefined || hold === undefined ? undefined : holdNote(mode, hold)
    if (quiet !== undefined) log(`${spec.name}: ${quiet}\n`)
    log(`running ${spec.name}: ${spec.command}\n`)
    const started = performance.now()
    let code: number
    let output: string
    try {
      ;({ code, output } = await execute(spec.command, opts.cwd, opts.env))
    } finally {
      await hold?.()
    }
    const ms = Math.round(performance.now() - started)
    const details = [
      ...(code === 0 ? [] : [`exit ${code}`]),
      ...(quiet === undefined ? [] : [quiet]),
    ]
    const detail = details.length === 0 ? {} : { detail: details.join('; ') }
    if (code === 0) {
      results.push({ name: spec.name, status: 'ok', ms, ...detail })
    } else {
      results.push({ name: spec.name, status: 'red', ms, ...detail })
      log(`${tail(output)}\n`)
    }
    log(`${spec.name}: ${results[results.length - 1]?.status} in ${seconds(ms)} s\n`)
  }
  const exitCode = results.some((s) => s.status === 'red') ? 1 : 0
  return { exitCode, steps: results, report: formatReport(results, opts.budgetMs) }
}

// ---------------------------------------------------------------------------------------------------------------
// Git and the repository
// ---------------------------------------------------------------------------------------------------------------

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function lines(text: string): string[] {
  return text.split('\n').filter(Boolean)
}

function repoRoot(): string {
  return git('.', ['rev-parse', '--show-toplevel']).trim()
}

/** `--base`, else the merge base with origin/dev, else with origin/main. */
export function resolveBase(root: string, requested: string | undefined): string {
  if (requested !== undefined) {
    return git(root, ['rev-parse', '--verify', `${requested}^{commit}`]).trim()
  }
  for (const ref of ['origin/dev', 'origin/main']) {
    try {
      return git(root, ['merge-base', 'HEAD', ref]).trim()
    } catch {
      // try the next one
    }
  }
  throw new Error('no base: pass --base <ref>, or fetch origin/dev or origin/main')
}

/**
 * Paths that differ between the base and the work tree, committed, staged or not, deletions included, plus untracked
 * files, each once. A deleted path is a change: removing a configuration file must still select every test.
 */
export function changedFiles(root: string, base: string): string[] {
  const tracked = lines(git(root, ['diff', '--name-only', base]))
  const untracked = lines(git(root, ['ls-files', '--others', '--exclude-standard']))
  return [...new Set([...tracked, ...untracked])].sort()
}

function isCensusFile(path: string): boolean {
  return TEST_FILE.test(path) && !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function headCensus(root: string): FileCensus[] {
  const paths = new Set([
    ...lines(git(root, ['ls-files'])),
    ...lines(git(root, ['ls-files', '--others', '--exclude-standard'])),
  ])
  return [...paths]
    .filter((path) => isCensusFile(path) && existsSync(resolve(root, path)))
    .sort()
    .map((path) => classifySource(readFileSync(resolve(root, path), 'utf8'), path))
}

/** Blob contents at a ref in one `git cat-file --batch` call. */
function blobsAt(root: string, ref: string, paths: string[]): Map<string, string> {
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: paths.map((p) => `${ref}:${p}\n`).join(''),
    maxBuffer: 256 * 1024 * 1024,
  })
  const blobs = new Map<string, string>()
  let offset = 0
  for (const path of paths) {
    const end = out.indexOf(0x0a, offset)
    const header = out.subarray(offset, end).toString('utf8').split(' ')
    offset = end + 1
    if (header[1] !== 'blob') continue
    const size = Number(header[2])
    blobs.set(path, out.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  return blobs
}

function baseCensus(root: string, base: string): FileCensus[] {
  const paths = lines(git(root, ['ls-tree', '-r', '--name-only', base])).filter(isCensusFile)
  const blobs = blobsAt(root, base, paths)
  return [...blobs].map(([path, source]) => classifySource(source, path))
}

// ---------------------------------------------------------------------------------------------------------------
// Steps that run inside this script (as `tsx scripts/gate.ts <name>`), so that every step has an exit code
// ---------------------------------------------------------------------------------------------------------------

const DELTA_KEYS: Array<keyof Totals> = [
  'files',
  'tests',
  'skipped',
  'C1',
  'C2',
  'C3',
  'C4',
  'other',
  'prints',
]

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * For each path the change adds or renames to: the path it moved from, or null when it is new. Git pairs a removed
 * file with the added file closest in content, so a codemod that moves one file and adds an identical one is paired
 * the wrong way round; a removed file's own name settles that before git's pairing does.
 */
export function moveSources(nameStatus: string): Map<string, string | null> {
  const removed = new Set<string>()
  const targets = new Map<string, string | null>()
  for (const line of nameStatus.split('\n')) {
    const [status, first, second] = line.split('\t')
    if (first === undefined) continue
    if (status === 'D') removed.add(first)
    else if (status === 'A') targets.set(first, null)
    else if (status?.startsWith('R') && second !== undefined) {
      removed.add(first)
      targets.set(second, first)
    }
  }
  const result = new Map<string, string | null>()
  const claimed = new Set<string>()
  for (const target of targets.keys()) {
    const same = [...removed].filter((path) => basename(path) === basename(target))
    if (same.length === 1 && !claimed.has(same[0] as string)) {
      claimed.add(same[0] as string)
      result.set(target, same[0] as string)
    }
  }
  for (const [target, gitSource] of targets) {
    if (result.has(target)) continue
    result.set(target, gitSource !== null && !claimed.has(gitSource) ? gitSource : null)
  }
  return result
}

/** Test files the change touches that rule 2 judges: new ones, and old ones it adds or edits an assertion in. */
function judgedTestFiles(root: string, base: string): string[] {
  const touched = changedFiles(root, base).filter(isCensusFile)
  const untracked = new Set(lines(git(root, ['ls-files', '--others', '--exclude-standard'])))
  const diff = git(root, ['diff', '-M', ...DIFF_FLAGS, base])
  const moves = moveSources(git(root, ['diff', '--name-status', '-M', base]))
  return touched.filter((path) => {
    if (untracked.has(path)) return true
    if (!moves.has(path)) return assertionTouched(diff, path)
    const source = moves.get(path)
    if (source === null || source === undefined) return true
    const pair = git(root, ['diff', '-M', ...DIFF_FLAGS, base, '--', source, path])
    return assertionTouched(pair, path)
  })
}

function censusTrendStep(root: string, base: string): number {
  const touched = judgedTestFiles(root, base)
  const { violations, delta } = censusTrend(baseCensus(root, base), headCensus(root), touched)
  for (const path of touched.filter((p) => p.startsWith('tests/e2e/journeys/'))) {
    const absolute = resolve(root, path)
    if (existsSync(absolute))
      violations.push(...journeyViolations(readFileSync(absolute, 'utf8'), path, root))
  }
  const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))
  process.stdout.write(
    `census trend against ${base.slice(0, 9)}: ${touched.length} test file(s) touched\n` +
      `delta: ${DELTA_KEYS.map((key) => `${key} ${signed(delta[key])}`).join(', ')}\n`,
  )
  for (const violation of violations) process.stdout.write(`violation: ${violation}\n`)
  return violations.length === 0 ? 0 : 1
}

type VitestReport = {
  testResults?: Array<{
    name: string
    assertionResults?: Array<{
      fullName?: string
      title?: string
      duration?: number | null
      status?: string
    }>
  }>
}

type StrykerReport = {
  files?: Record<string, { mutants?: Array<{ killedBy?: string[] }> }>
  testFiles?: Record<string, { tests?: Array<{ id: string }> }>
}

/** A report file written during this run; an older one is a leftover and says nothing about this change. */
function freshReport<T>(path: string, startedMs: number): T | undefined {
  if (!existsSync(path) || statSync(path).mtimeMs < startedMs) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function killedBy(
  report: StrykerReport,
  testFile: string,
): { killed: number; total: number } | undefined {
  const key = Object.keys(report.testFiles ?? {}).find(
    (k) => k === testFile || k.endsWith(`/${testFile}`),
  )
  if (key === undefined) return undefined
  const ids = new Set((report.testFiles?.[key]?.tests ?? []).map((t) => t.id))
  const mutants = Object.values(report.files ?? {}).flatMap((f) => f.mutants ?? [])
  return {
    killed: mutants.filter((m) => (m.killedBy ?? []).some((id) => ids.has(id))).length,
    total: mutants.length,
  }
}

export function renderTestQuality(input: {
  base: string
  files: FileCensus[]
  vitest: VitestReport | undefined
  stryker: StrykerReport | undefined
  root: string
}): string {
  const out = [
    '# Test quality',
    '',
    `Base ${input.base.slice(0, 9)}. New or changed test files: ${input.files.length}.`,
  ]
  for (const file of input.files) {
    const a = file.assertions
    out.push('', `## ${file.path}`, '')
    out.push(`- assertions: C1 ${a.C1}, C2 ${a.C2}, C3 ${a.C3}, C4 ${a.C4}, other ${a.other}`)
    if (input.stryker === undefined) {
      out.push('- mutants killed: not available (Stryker did not run in this gate)')
    } else {
      const killed = killedBy(input.stryker, file.path)
      out.push(
        killed === undefined
          ? '- mutants killed: 0 (Stryker ran no test from this file)'
          : `- mutants killed: ${killed.killed} of ${killed.total} in Stryker's report`,
      )
    }
    const result = input.vitest?.testResults?.find(
      (r) => relative(input.root, r.name) === file.path,
    )
    if (input.vitest === undefined) {
      out.push('- runtime: not available (the tests step did not write a Vitest JSON report)')
    } else if (result === undefined) {
      out.push(
        '- runtime: this file is not in the Vitest report (another runner, or not collected)',
      )
    } else {
      out.push('- runtime of each test:', '', '| ms | test |', '|---:|---|')
      for (const test of result.assertionResults ?? []) {
        const name = (test.fullName ?? test.title ?? '(unnamed)').replaceAll('|', '\\|')
        out.push(`| ${Math.round(test.duration ?? 0)} | ${name} |`)
      }
    }
  }
  return `${out.join('\n')}\n`
}

function testQualityStep(root: string, base: string, startedMs: number): number {
  const touched = changedFiles(root, base).filter(isCensusFile)
  const head = headCensus(root)
  const files = head.filter((f) => touched.includes(f.path))
  const reports = resolve(root, 'reports')
  const text = renderTestQuality({
    base,
    files,
    root,
    vitest: freshReport<VitestReport>(resolve(reports, 'vitest.json'), startedMs),
    stryker: freshReport<StrykerReport>(resolve(reports, 'mutation/mutation.json'), startedMs),
  })
  const target = resolve(reports, 'test-quality.md')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  process.stdout.write(`wrote ${relative(root, target)}: ${files.length} test file(s)\n`)
  return 0
}

// ---------------------------------------------------------------------------------------------------------------
// The steps of gate and gate:full
// ---------------------------------------------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 2
    } else if (glob.startsWith('**', i)) {
      source += '.*'
      i += 1
    } else if (ch === '*') {
      source += '[^/]*'
    } else {
      source += ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

type StrykerConfig = { mutate: string[]; incrementalFile?: string }

async function strykerConfig(root: string): Promise<StrykerConfig> {
  const config = (await import(pathToFileURL(resolve(root, 'stryker.config.mjs')).href)) as {
    default: StrykerConfig
  }
  return config.default
}

/** The paths that fall inside Stryker's `mutate` set (its own config is the source of that set). */
export async function mutateSet(root: string, changed: string[]): Promise<string[]> {
  const { mutate } = await strykerConfig(root)
  const include = mutate.filter((g) => !g.startsWith('!')).map(globToRegExp)
  const exclude = mutate.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)))
  return changed.filter(
    (path) => include.some((re) => re.test(path)) && !exclude.some((re) => re.test(path)),
  )
}

/** A path whose change can move a mutation score without touching a mutated file: the platform's tests and Stryker's configs. */
function isStrykerInput(path: string): boolean {
  return (
    path === 'stryker.config.mjs' ||
    path === 'vitest.stryker.config.ts' ||
    (path.startsWith('packages/platform/src/') && path.endsWith('.test.ts'))
  )
}

/**
 * The files Stryker mutates for this change set: the whole mutate set whenever one of its tests or configs changed,
 * otherwise the changed ones in the set. A changed test invalidates cached kills in files it did not change, and a
 * `--mutate` narrowed to the changed sources leaves those unmeasured; incremental mode re-measures only the mutants
 * the changed tests can move, so the whole set costs only those. `remeasured` (the files whose ratchet entry moved)
 * are mutated as well, whatever changed.
 */
export async function strykerTargets(
  root: string,
  changed: string[],
  remeasured: string[] = [],
): Promise<string[]> {
  // `changed` carries untracked files, which `ls-files` alone would drop from the set.
  const candidates = changed.some(isStrykerInput)
    ? [...lines(git(root, ['ls-files'])), ...changed]
    : changed
  // A deleted file has nothing left to mutate.
  return mutateSet(
    root,
    [...new Set([...candidates, ...remeasured])].filter((path) => existsSync(resolve(root, path))),
  )
}

const RATCHET = 'mutation-ratchet.json'

function ratchetFiles(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  return (JSON.parse(text) as { files?: Record<string, unknown> }).files ?? {}
}

/**
 * The files whose entry in the head's mutation-ratchet.json is new or differs from the base's (both given as text;
 * an empty text is a ratchet with no entries). Their cached mutant statuses predate the entry, so they are measured
 * fresh; every other file keeps its cache.
 */
export function ratchetChanges(base: string, head: string): string[] {
  const before = ratchetFiles(base)
  return Object.entries(ratchetFiles(head))
    .filter(([path, score]) => !Object.hasOwn(before, path) || before[path] !== score)
    .map(([path]) => path)
}

/** `ratchetChanges` between the ratchet at `base` and the one in the working tree. */
function ratchetChangesSince(root: string, base: string): string[] {
  const path = resolve(root, RATCHET)
  const head = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const atBase =
    git(root, ['ls-tree', '--name-only', base, '--', RATCHET]).trim() === ''
      ? ''
      : git(root, ['show', `${base}:${RATCHET}`])
  return atBase === head ? [] : ratchetChanges(atBase, head)
}

/** Stryker's own default, when its config names no incremental file. */
const STRYKER_INCREMENTAL_DEFAULT = 'reports/stryker-incremental.json'

/** Drops `files` from Stryker's incremental report, so its next run measures their mutants afresh. */
async function pruneIncremental(root: string, files: string[]): Promise<void> {
  const report = resolve(
    root,
    (await strykerConfig(root)).incrementalFile ?? STRYKER_INCREMENTAL_DEFAULT,
  )
  if (!existsSync(report)) {
    process.stderr.write(`stryker: no incremental report at ${relative(root, report)} to prune\n`)
    return
  }
  const data = JSON.parse(readFileSync(report, 'utf8')) as { files?: Record<string, unknown> }
  const cached = data.files ?? {}
  const dropped = files.filter((path) => Object.hasOwn(cached, path))
  for (const path of dropped) delete cached[path]
  writeFileSync(report, JSON.stringify(data))
  process.stderr.write(
    `stryker: ratchet entries moved, measured afresh: ${files.join(', ')} (${dropped.length} in the cache)\n`,
  )
}

export type PlanInput = {
  full: boolean
  base: string
  changed: string[]
  mutated: string[]
  /** Files in `mutated` whose cached mutants the stryker step drops first (`ratchetChanges`). None when not given. */
  remeasured?: string[] | undefined
  /** Run only these steps, in plan order. A name the plan does not have is an error. */
  only?: string[] | undefined
  /** `compose` starts the services here; `external` expects them to exist (CI services) at `postgresUrl`. */
  services?: 'compose' | 'external' | undefined
  postgresUrl?: string | undefined
  /** Where `external` services have Mailpit's API. */
  mailpitUrl?: string | undefined
  /** Where `external` services have Redis. */
  redisUrl?: string | undefined
  /** Where `external` services have an S3 API; with compose, the port compose.yaml publishes MinIO on. */
  s3Endpoint?: string | undefined
  minioPort?: string | undefined
  /** The worktree's stack slot: its compose project and service ports. Slot 0 when not given. */
  stack?: StackBlock
  /** The store set the E2E steps run on (`--stores`); `sqlite-memory`, today's plan, when not given. */
  stores?: StoreSet | undefined
  /** The build is not run here: its output is met by a downloaded artefact, if `artefactPresent`. */
  noBuild?: boolean | undefined
  artefactPresent?: boolean | undefined
  /** `packages/<dir>` of the proof kit and what it imports (`workspaceClosure`); the kit alone when not given. */
  proofKitPackages?: string[] | undefined
  /** `packages/<dir>` of the kernel and what it imports, which the timing-bound tests load; the kernel when not given. */
  perfPackages?: string[] | undefined
  /** The sentinels gate:full runs: every one, or a selection (`selectSentinels`). Every one when not given. */
  sentinels?: 'all' | Set<string> | undefined
  /** `--rerun-red`: the tests step runs these tests alone (when any), and Playwright only its last failures. */
  rerun?: { tests: RedTest[] } | undefined
}

/** A Vitest test by file (from the root) and full name (describe titles and its own, joined by spaces). */
export type RedTest = { file: string; name: string }

/** What `--rerun-red` reads back: every gate run writes it. `e2e[target]` is true when that E2E step was red. */
export type LastRun = {
  sha: string
  diffHash: string
  steps: Record<string, StepStatus>
  vitest: RedTest[]
  e2e: Record<string, boolean>
}

const LAST_RUN = 'reports/last-run.json'
const RERUN_REPORT = 'reports/vitest-rerun.json'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Vitest on the red files, filtered to the red tests by full name (the name `-t` matches starts with the file's). */
function rerunTestsCommand(red: RedTest[]): string {
  const files = [...new Set(red.map((t) => t.file))].map(shellWord).join(' ')
  const names = [...new Set(red.map((t) => escapeRegExp(t.name)))].join('|')
  return (
    `pnpm run test ${files} -t ${shellWord(`(?:^|\\s)(?:${names})$`)} ` +
    `--reporter=default --reporter=json --outputFile.json=${RERUN_REPORT}`
  )
}

const SCRIPT = 'node_modules/.bin/tsx scripts/gate.ts'
/** The `perf` project's timing-bound file, which `pnpm test` would collect too; `perf-postgres` is apart already. */
const PERF_FILE = 'packages/platform/tests/integration/search-performance.test.ts'
/** The steps that load the CPU, besides the E2E steps: each holds a shared hold of the quiet lock while it runs. */
const SHARED_HOLD_STEPS = new Set([
  'tests',
  'integration-postgres',
  'proof-kit-services',
  'integration-stores',
  'stryker',
  'sentinels',
  'tests-fail-on-base',
])
const EXCLUSIVE_HOLD_STEPS = new Set(['perf', 'perf-postgres'])

/** Marks each step with the hold it takes while it runs. */
function withHolds(steps: StepSpec[]): StepSpec[] {
  return steps.map((step) =>
    EXCLUSIVE_HOLD_STEPS.has(step.name)
      ? { ...step, hold: 'exclusive' }
      : SHARED_HOLD_STEPS.has(step.name) || step.name.startsWith('e2e ')
        ? { ...step, hold: 'shared' }
        : step,
  )
}
/** Where the tests step's Vitest JSON goes: test-quality reads it, and `--rerun-red` finds the red tests in it. */
const VITEST_REPORT = 'reports/vitest.json'
const VITEST_JSON = `--reporter=default --reporter=json --outputFile.json=${VITEST_REPORT}`
/** Left by scripts/e2e-server.mjs when a server outlived its shutdown. */
const SHUTDOWN_REPORT = 'reports/e2e-shutdown.json'
/** The build output each E2E target serves itself. The templates run as dev servers; the API serves the admin. */
const E2E_SERVES: Record<string, string[]> = {
  astro: [],
  nextjs: [],
  admin: ['apps/admin/dist/index.html'],
  // The custom-providers fixture store (tests/e2e/fixtures/custom-providers) with each template on it.
  'astro-custom': [],
  'nextjs-custom': [],
  // The no-search fixture store (tests/e2e/fixtures/no-search) with each template on it.
  'astro-nosearch': [],
  'nextjs-nosearch': [],
}

/**
 * An E2E step: red at once when an output it serves is missing, before Playwright starts; red when the server
 * wrapper recorded a hang on shutdown (the file is cleared first, so only this run's counts).
 */
function e2eCommand(target: string, playwright: string): string {
  const missing = (E2E_SERVES[target] ?? []).map(
    (path) =>
      `{ test -f ${path} || { echo "e2e ${target}: ${path} is missing (run the build step)"; exit 1; }; }`,
  )
  return [
    ...missing,
    `rm -f ${SHUTDOWN_REPORT}`,
    `${playwright}; code=$?`,
    `if [ -f ${SHUTDOWN_REPORT} ]; then echo "e2e ${target}: a server outlived its shutdown: $(cat ${SHUTDOWN_REPORT})"; exit 1; fi`,
    'exit $code',
  ].join('; ')
}

function shellWord(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * Settles at plan time the needs that flags decide. A need met by a flag is dropped; a need a flag cannot meet, or
 * that `only` leaves out, skips the step naming why. The rest stay for `run` to judge against the earlier steps.
 */
function settle(steps: StepSpec[], input: PlanInput): StepSpec[] {
  const external = input.services === 'external'
  const met = new Set<string>()
  const unmet = new Map<string, string>()
  if (external) {
    if (input.postgresUrl !== undefined && input.postgresUrl !== '') met.add('compose up')
    else unmet.set('compose up', 'NYMBAL_TEST_POSTGRES_URL is not set (--services external)')
  }
  if (input.noBuild === true) {
    if (input.artefactPresent === true) met.add('build')
    else unmet.set('build', 'the build artefact is not present (--no-build)')
  }
  const selected = new Set(steps.map((step) => step.name))
  return steps.map((step) => {
    const reasons: string[] = []
    const needs: string[] = []
    for (const need of step.needs ?? []) {
      const why = unmet.get(need)
      if (met.has(need)) continue
      if (why !== undefined) reasons.push(why)
      else if (!selected.has(need)) reasons.push(`needs ${need}, which --only leaves out`)
      else needs.push(need)
    }
    const { needs: _declared, ...rest } = step
    const skip = step.skip ?? (reasons.length > 0 ? reasons.join('; ') : undefined)
    return {
      ...rest,
      ...(skip === undefined ? {} : { skip }),
      ...(needs.length > 0 ? { needs } : {}),
    }
  })
}

/** The steps `only` names, in plan order, with their flag-decided needs settled. An unknown name is an error. */
function select(steps: StepSpec[], input: PlanInput): StepSpec[] {
  const { only } = input
  if (only === undefined) return settle(steps, input)
  const known = steps.map((step) => step.name)
  const unknown = only.filter((name) => !known.includes(name))
  if (unknown.length > 0) {
    throw new Error(
      `unknown step${unknown.length > 1 ? 's' : ''} for --only: ${unknown.map((n) => `"${n}"`).join(', ')}\n` +
        `known steps: ${known.join(', ')}`,
    )
  }
  return settle(
    steps.filter((step) => only.includes(step.name)),
    input,
  )
}

export function plan(input: PlanInput): { steps: StepSpec[]; budgetMs: number } {
  const { full, base, changed, mutated } = input
  const remeasured = input.remeasured ?? []
  const prune =
    remeasured.length === 0
      ? ''
      : `${SCRIPT} incremental-prune ${shellWord(remeasured.join(','))} && `
  const selection = full
    ? { mode: 'all' as const, reason: 'gate:full runs every test' }
    : selectTests(changed)
  // Tests and typecheck read other packages through their `dist`: gate:full always builds first, the plain gate when
  // a package's build input changed (a warm build is about 7 s).
  const buildInputs = changed.filter(isBuildInput)
  const build: StepSpec = full
    ? input.noBuild === true
      ? {
          name: 'build',
          command: 'true',
          skip: 'the build artefact is used (--no-build)',
          idle: true,
        }
      : // `pnpm build` covers packages/** only; the admin E2E serves apps/admin/dist, which a fresh checkout lacks.
        { name: 'build', command: 'pnpm build && pnpm --filter @nymbalhq/admin build' }
    : buildInputs.length === 0
      ? { name: 'build', command: 'true', skip: 'no package build input changed', idle: true }
      : { name: 'build', command: 'pnpm build' }
  const buildNeeds = full || buildInputs.length > 0 ? { needs: ['build'] } : {}
  // `--changed` follows imports, and an import of `dist` leads to no changed file, so a change to the kit or to what it
  // imports runs the kit's own tests as well.
  const kit = input.proofKitPackages ?? ['packages/proof-kit']
  const kitChanged = buildInputs.some((path) => kit.some((dir) => path.startsWith(`${dir}/`)))
  const red = input.rerun?.tests ?? []
  // The timing-bound tests run in steps of their own. When `--only` leaves those steps out (CI's jobs name theirs), the
  // tests and integration-postgres steps run them, as they did before the steps existed.
  const picked = (name: string): boolean => input.only === undefined || input.only.includes(name)
  const perfApart = picked('perf') ? ` --exclude ${PERF_FILE}` : ''
  const perfPackages = input.perfPackages ?? ['packages/platform']
  const perfReached =
    selection.mode === 'all' ||
    (selection.mode === 'changed' &&
      changed.some(
        (path) => !isDocumentation(path) && perfPackages.some((dir) => path.startsWith(`${dir}/`)),
      ))
  const perf: StepSpec = perfReached
    ? { name: 'perf', command: 'pnpm exec vitest run --project perf', ...buildNeeds }
    : {
        name: 'perf',
        command: 'true',
        skip: 'no change reaches the timing-bound tests',
        idle: true,
      }
  const tests: StepSpec =
    red.length > 0
      ? { name: 'tests', command: rerunTestsCommand(red), ...buildNeeds }
      : selection.mode === 'none'
        ? { name: 'tests', command: 'true', skip: selection.reason, idle: true }
        : selection.mode === 'changed'
          ? {
              name: 'tests',
              command:
                `pnpm run test --changed ${base} --passWithNoTests${perfApart} ${VITEST_JSON}` +
                (kitChanged ? ' && pnpm exec vitest run --project proof-kit' : ''),
              ...buildNeeds,
            }
          : { name: 'tests', command: `pnpm run test${perfApart} ${VITEST_JSON}`, ...buildNeeds }
  const steps: StepSpec[] = [
    { name: 'lint', command: 'pnpm lint' },
    build,
    { name: 'typecheck', command: 'pnpm typecheck' },
    tests,
    perf,
    { name: 'census trend', command: `${SCRIPT} census-trend ${base}` },
  ]
  if (!full) return { steps: select(withHolds(steps), input), budgetMs: GATE_BUDGET_MS }

  const external = input.services === 'external'
  const block = input.stack ?? stackBlock(0)
  const composedPostgres = postgresUrl(block.postgres)
  const postgresAt = external ? (input.postgresUrl ?? composedPostgres) : composedPostgres
  const composedMailpit = mailpitUrl(block.mailpitUi)
  const postgres = `NYMBAL_TEST_POSTGRES_URL=${shellWord(postgresAt)}`
  const mailpit = `NYMBAL_TEST_MAILPIT_URL=${shellWord(external ? (input.mailpitUrl ?? composedMailpit) : composedMailpit)} NYMBAL_TEST_MAILPIT_SMTP=localhost:${block.mailpitSmtp}`
  const composedRedis = redisUrl(block.redis)
  const redisAt = external ? (input.redisUrl ?? composedRedis) : composedRedis
  const redis = `NYMBAL_TEST_REDIS_URL=${shellWord(redisAt)}`
  // An explicit NYMBAL_MINIO_PORT moves MinIO off the block's port, for compose and the endpoint alike.
  const minioPort = input.minioPort ?? String(block.minio)
  // External services bring their own credentials in the environment; compose's MinIO has its default root ones.
  const s3 = external
    ? `NYMBAL_TEST_S3_ENDPOINT=${shellWord(input.s3Endpoint ?? minioUrl())}`
    : `NYMBAL_TEST_S3_ENDPOINT=${shellWord(minioUrl(minioPort))} NYMBAL_TEST_S3_ACCESS_KEY_ID=minioadmin NYMBAL_TEST_S3_SECRET_ACCESS_KEY=minioadmin`
  // Slot 0 is compose.yaml's own project and default ports; another slot names both, so worktrees share no container.
  const compose =
    block.slot === 0
      ? 'docker compose up -d --wait'
      : `${Object.entries({ ...composePorts(block), NYMBAL_MINIO_PORT: minioPort })
          .map(([name, value]) => `${name}=${shellWord(value)}`)
          .join(' ')} docker compose -p ${block.project} up -d --wait`
  // Playwright takes its servers' ports from the slot; slot 0 is what it resolves on its own in the main checkout.
  const slotEnv = block.slot === 0 ? '' : `NYMBAL_STACK_SLOT=${block.slot} `
  // A set other than the default points the repo-root config at the composed services; the E2E server wrapper gives
  // the run a database and a key prefix of its own.
  const stores = storeSet(input.stores ?? 'sqlite-memory')
  const set = STORE_SETS[stores]
  const storeEnv =
    stores === 'sqlite-memory'
      ? ''
      : [
          `NYMBAL_COMMAND_STORE=${set.commandStore}`,
          `NYMBAL_DOCUMENT_STORE=${set.documentStore}`,
          `NYMBAL_EVENT_BUS=${set.eventBus}`,
          `DATABASE_URL=${shellWord(postgresAt)}`,
          ...(usesRedis(set) ? [`REDIS_URL=${shellWord(redisAt)}`] : []),
        ].join(' ') + ' '
  const e2eNeeds = stores === 'sqlite-memory' ? ['build'] : ['build', 'compose up']
  // Visual baselines are linux/chromium: on another platform every @visual test would fail on the missing baseline.
  const grep = process.platform === 'linux' ? '' : ' --grep-invert @visual'
  const lastFailed = input.rerun === undefined ? '' : ' --last-failed'
  // `--last-failed` reads `.last-run.json` from the output dir, so each project keeps its own or the last one wins.
  const e2e = (target: string): string =>
    e2eCommand(
      target,
      `${slotEnv}${storeEnv}CI=1 NYMBAL_E2E_TARGET=${target} pnpm --filter @nymbalhq/e2e exec playwright test --project ${target} --output test-results/${target}${grep}${lastFailed}`,
    )
  const chosen = input.sentinels ?? 'all'
  const sentinels: StepSpec =
    chosen === 'all'
      ? { name: 'sentinels', command: `${postgres} pnpm sentinels` }
      : chosen.size === 0
        ? {
            name: 'sentinels',
            command: 'true',
            skip: 'no sentinel is impacted by the changed files (--sentinels all runs every one)',
            idle: true,
          }
        : {
            name: 'sentinels',
            command: `${postgres} pnpm sentinels --only ${[...chosen].sort().join(',')}`,
          }
  steps.push(
    external
      ? {
          name: 'compose up',
          command: 'true',
          skip: 'services are external (--services external)',
          idle: true,
        }
      : { name: 'compose up', command: compose },
    {
      name: 'integration-postgres',
      command: `${postgres} pnpm exec vitest run --project integration-postgres${picked('perf-postgres') ? '' : ' --project perf-postgres'}`,
      needs: ['compose up'],
    },
    {
      name: 'perf-postgres',
      command: `${postgres} pnpm exec vitest run --project perf-postgres`,
      needs: ['compose up'],
    },
    {
      name: 'proof-kit-services',
      command: `${postgres} ${mailpit} pnpm exec vitest run --project proof-kit-services`,
      needs: ['compose up', 'build'],
    },
    // The document store and bus contracts on Redis and Postgres JSONB, the S3 media storage on MinIO, and the kernel
    // on them (it loads the built packages).
    {
      name: 'integration-stores',
      command: `${postgres} ${redis} ${s3} pnpm exec vitest run --project integration-stores`,
      needs: ['compose up', 'build'],
    },
    mutated.length === 0
      ? {
          name: 'stryker',
          command: 'true',
          skip: "no changed file in Stryker's mutate set, its platform tests or its configs",
          idle: true,
        }
      : {
          // Stryker exits 0 with survivors; the ratchet is what fails a file whose score fell.
          name: 'stryker',
          command: `${prune}pnpm exec stryker run --mutate ${shellWord(mutated.join(','))} && pnpm --silent mutation:ratchet check --report reports/mutation/mutation.json`,
        },
    // A sentinel whose `# suite:` runs the Postgres project reads the URL from here, not from its header.
    sentinels,
    {
      name: 'tests-fail-on-base',
      command: `${postgres} ${mailpit} ${redis} ${s3} node_modules/.bin/tsx scripts/tests-fail-on-base.ts ${base}`,
      needs: ['compose up'],
    },
    // The journeys run against the built packages: without a build they test nothing new. Playwright starts its own
    // API, which uses the composed services only on a --stores set other than sqlite-memory.
    { name: 'e2e astro', command: e2e('astro'), needs: e2eNeeds },
    { name: 'e2e nextjs', command: e2e('nextjs'), needs: e2eNeeds },
    { name: 'e2e admin', command: e2e('admin'), needs: e2eNeeds },
  )
  // The same journeys on the store whose search and payments are swapped for `custom` adapters, and the @nosearch
  // journeys on the store whose search offers nothing. They prove the templates follow the adapters, which no store
  // set changes, so they run on the default set only. Each target is its own invocation after the others:
  // nextjs-custom and nextjs-nosearch serve the same templates/nextjs as nextjs.
  if (stores === 'sqlite-memory') {
    steps.push(
      { name: 'e2e astro-custom', command: e2e('astro-custom'), needs: e2eNeeds },
      { name: 'e2e nextjs-custom', command: e2e('nextjs-custom'), needs: e2eNeeds },
      { name: 'e2e astro-nosearch', command: e2e('astro-nosearch'), needs: e2eNeeds },
      { name: 'e2e nextjs-nosearch', command: e2e('nextjs-nosearch'), needs: e2eNeeds },
    )
  }
  return { steps: select(withHolds(steps), input), budgetMs: FULL_BUDGET_MS }
}

/** Build outputs outside `packages/` that the E2E steps serve: both templates and the admin SPA. */
const APP_OUTPUTS = ['templates/astro/dist', 'templates/nextjs/.next', 'apps/admin/dist']

/**
 * Whether the whole build output is in the work tree (a downloaded CI artefact, or a build): the `dist` of every
 * package that has a build script, and every entry of `APP_OUTPUTS`.
 */
export function artefactPresent(root: string): boolean {
  const packages = resolve(root, 'packages')
  if (!existsSync(packages)) return false
  const builders = readdirSync(packages).filter((name) => {
    const manifest = resolve(packages, name, 'package.json')
    if (!existsSync(manifest)) return false
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: { build?: string } }
    return typeof pkg.scripts?.build === 'string'
  })
  return (
    builders.length > 0 &&
    builders.every((name) => existsSync(resolve(packages, name, 'dist'))) &&
    APP_OUTPUTS.every((path) => existsSync(resolve(root, path)))
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The last run, and --rerun-red
// ---------------------------------------------------------------------------------------------------------------

/** A hash of the work tree against HEAD, untracked files included: equal hashes mean nothing was edited between. */
function diffHash(root: string): string {
  const hash = createHash('sha256')
  hash.update(git(root, ['rev-parse', 'HEAD']))
  hash.update(git(root, ['diff', 'HEAD', '--binary']))
  for (const path of lines(git(root, ['ls-files', '--others', '--exclude-standard'])).sort()) {
    const absolute = resolve(root, path)
    hash.update(`\0${path}\0`)
    if (existsSync(absolute) && statSync(absolute).isFile()) hash.update(readFileSync(absolute))
  }
  return hash.digest('hex')
}

function testsWith(root: string, report: VitestReport | undefined, status: string): RedTest[] {
  return (report?.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((t) => t.status === status)
      .map((t) => ({ file: relative(root, file.name), name: t.fullName ?? t.title ?? '' })),
  )
}

function writeLastRun(root: string, steps: Step[], startedMs: number): void {
  const status = (name: string): StepStatus | undefined =>
    steps.find((s) => s.name === name)?.status
  const last: LastRun = {
    sha: git(root, ['rev-parse', 'HEAD']).trim(),
    diffHash: diffHash(root),
    steps: Object.fromEntries(steps.map((s) => [s.name, s.status])),
    vitest:
      status('tests') === 'red'
        ? testsWith(
            root,
            freshReport<VitestReport>(resolve(root, VITEST_REPORT), startedMs),
            'failed',
          )
        : [],
    e2e: Object.fromEntries(
      steps
        .filter((s) => s.name.startsWith('e2e '))
        .map((s) => [s.name.slice(4), s.status === 'red']),
    ),
  }
  const target = resolve(root, LAST_RUN)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(last, null, 2)}\n`)
}

function readLastRun(root: string): LastRun {
  const path = resolve(root, LAST_RUN)
  if (!existsSync(path)) throw new Error(`--rerun-red: no ${LAST_RUN}; run the gate first`)
  return JSON.parse(readFileSync(path, 'utf8')) as LastRun
}

/** The steps that were red last time, in plan order; a need on a step that is not re-run was met then. */
function redSteps(steps: StepSpec[], last: LastRun): StepSpec[] {
  const kept = steps.filter((s) => last.steps[s.name] === 'red')
  const names = new Set(kept.map((s) => s.name))
  return kept.map((s) => {
    const { needs, ...rest } = s
    const still = (needs ?? []).filter((n) => names.has(n))
    return still.length > 0 ? { ...rest, needs: still } : rest
  })
}

/**
 * Prints the re-run's rows, a `flaky:` line for each test that went green on an unchanged tree, and the count. It
 * returns 1 whatever ran: a re-run of part of the gate is never its verdict.
 */
function reportRerun(root: string, result: RunResult, last: LastRun, startedMs: number): number {
  const green: string[] = []
  const red: string[] = []
  const flakyCandidates: string[] = []
  for (const step of result.steps) {
    if (step.name === 'tests' && last.vitest.length > 0) {
      const passed = testsWith(
        root,
        freshReport<VitestReport>(resolve(root, RERUN_REPORT), startedMs),
        'passed',
      )
      for (const t of last.vitest) {
        const unit = `${t.file} > ${t.name}`
        if (passed.some((p) => p.file === t.file && p.name === t.name)) {
          green.push(unit)
          flakyCandidates.push(unit)
        } else red.push(unit)
      }
      continue
    }
    if (step.status === 'ok') {
      green.push(step.name)
      if (step.name.startsWith('e2e ')) flakyCandidates.push(step.name)
    } else red.push(step.name)
  }
  // A red step this plan does not have (a gate:full step re-run without --full) did not go green.
  const ran = new Set(result.steps.map((s) => s.name))
  const absent = Object.keys(last.steps).filter((n) => last.steps[n] === 'red' && !ran.has(n))
  red.push(...absent)
  const unchanged = diffHash(root) === last.diffHash
  const out = [
    ...(green.length + red.length === 0 ? ['nothing was red in the last run'] : []),
    ...(absent.length > 0
      ? [`not re-run: ${absent.join(', ')} (not in this plan; add --full)`]
      : []),
    ...result.report.split('\n').slice(0, -1),
    ...(unchanged ? flakyCandidates.map((unit) => `flaky: ${unit}`) : []),
    `rerun: ${green.length} green, ${red.length} red, not a gate verdict`,
  ]
  process.stdout.write(`${out.join('\n')}\n`)
  return 1
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      full: { type: 'boolean', default: false },
      base: { type: 'string' },
      json: { type: 'boolean', default: false },
      started: { type: 'string' },
      only: { type: 'string' },
      services: { type: 'string', default: 'compose' },
      'no-build': { type: 'boolean', default: false },
      sentinels: { type: 'string', default: 'impacted' },
      stores: { type: 'string' },
      'rerun-red': { type: 'boolean', default: false },
    },
  })
  const root = repoRoot()
  const [subcommand, subBase] = positionals
  if (subcommand === 'incremental-prune') {
    if (subBase === undefined) throw new Error('usage: gate.ts incremental-prune <file,…>')
    await pruneIncremental(root, subBase.split(','))
    return 0
  }
  if (subcommand !== undefined) {
    // A step judges against the base the gate passed it, never one looked up again from origin/*.
    if (subBase === undefined) throw new Error(`usage: gate.ts ${subcommand} <base>`)
    const stepBase = resolveBase(root, subBase)
    if (subcommand === 'census-trend') return censusTrendStep(root, stepBase)
    if (subcommand === 'test-quality') {
      return testQualityStep(root, stepBase, Number(values.started ?? 0))
    }
    throw new Error(`unknown step "${subcommand}"`)
  }

  if (values.services !== 'compose' && values.services !== 'external') {
    throw new Error(`--services takes compose or external, not "${values.services}"`)
  }
  const only = values.only?.split(',').map((name) => name.trim())
  if (only !== undefined && !values.full) throw new Error('--only needs --full')
  const stores = values.stores === undefined ? undefined : storeSet(values.stores)
  if (stores !== undefined && !values.full) throw new Error('--stores needs --full')
  if (values.sentinels !== 'all' && values.sentinels !== 'impacted') {
    throw new Error(`--sentinels takes all or impacted, not "${values.sentinels}"`)
  }
  const rerun = values['rerun-red']
  if (rerun && only !== undefined)
    throw new Error('--rerun-red runs what was red; it takes no --only')
  const last = rerun ? readLastRun(root) : undefined
  const base = resolveBase(root, values.base)
  const startedMs = Date.now()
  const changed = changedFiles(root, base)
  const moved = values.full ? ratchetChangesSince(root, base) : []
  const mutated = values.full ? await strykerTargets(root, changed, moved) : []
  const remeasured = moved.filter((path) => mutated.includes(path))
  const postgresUrl = process.env.NYMBAL_TEST_POSTGRES_URL
  const mailpitUrl = process.env.NYMBAL_TEST_MAILPIT_URL
  const redisUrl = process.env.NYMBAL_TEST_REDIS_URL
  const s3Endpoint = process.env.NYMBAL_TEST_S3_ENDPOINT
  const minioPort = process.env.NYMBAL_MINIO_PORT
  // Only gate:full starts services and servers; the plain gate needs no slot.
  const block = values.full ? stack(root) : undefined
  const sentinelsDir = resolve(root, 'tests/sentinels')
  const allSentinels = values.full && existsSync(sentinelsDir) ? loadSentinels(sentinelsDir) : []
  const sentinels =
    values.sentinels === 'all' || allSentinels.length === 0
      ? ('all' as const)
      : selectSentinels(allSentinels, changed, (dir) => workspaceClosure(root, dir))
  const planned = plan({
    full: values.full,
    base,
    changed,
    mutated,
    remeasured,
    ...(only === undefined ? {} : { only }),
    services: values.services,
    ...(postgresUrl === undefined || postgresUrl === '' ? {} : { postgresUrl }),
    ...(mailpitUrl === undefined || mailpitUrl === '' ? {} : { mailpitUrl }),
    ...(redisUrl === undefined || redisUrl === '' ? {} : { redisUrl }),
    ...(s3Endpoint === undefined || s3Endpoint === '' ? {} : { s3Endpoint }),
    ...(minioPort === undefined || minioPort === '' ? {} : { minioPort }),
    ...(stores === undefined ? {} : { stores }),
    ...(block === undefined ? {} : { stack: block }),
    noBuild: values['no-build'],
    artefactPresent: values['no-build'] && artefactPresent(root),
    proofKitPackages: workspaceClosure(root, 'packages/proof-kit'),
    perfPackages: workspaceClosure(root, 'packages/platform'),
    sentinels,
    ...(last === undefined
      ? {}
      : { rerun: { tests: last.steps.tests === 'red' ? last.vitest : [] } }),
  })
  const { budgetMs } = planned
  const steps = last === undefined ? planned.steps : redSteps(planned.steps, last)
  if (values.full && only === undefined && last === undefined) {
    // The report reads what the steps above wrote, so it runs last and is part of the verdict.
    steps.push({
      name: 'test-quality report',
      command: `${SCRIPT} test-quality ${base} --started ${startedMs}`,
    })
  }
  const log = (text: string): void => {
    process.stderr.write(text)
  }
  if (steps.some((s) => s.name === 'sentinels' && s.skip === undefined)) {
    log(
      sentinels === 'all'
        ? `sentinels: all (${values.sentinels === 'all' ? '--sentinels all' : 'no tests/sentinels/ to select from'})\n`
        : `sentinels: --sentinels impacted selects ${sentinels.size} of ${allSentinels.length}: ${[...sentinels].sort().join(', ')}\n`,
    )
  } else if (sentinels !== 'all' && steps.some((s) => s.name === 'sentinels')) {
    log(`sentinels: --sentinels impacted selects none of ${allSentinels.length}\n`)
  }
  const result = await run(steps, { cwd: root, budgetMs, log })
  if (last !== undefined) return reportRerun(root, result, last, startedMs)
  writeLastRun(root, result.steps, startedMs)
  // A selected step skipped because a precondition failed (a URL unset, the artefact missing, a need left out)
  // proves nothing: the run is red, and the rows say why. A skip with nothing to do (no changed file to mutate,
  // services or build supplied from outside) is not.
  const unmet =
    only === undefined
      ? []
      : steps.filter((spec) => spec.skip !== undefined && spec.idle !== true).map((s) => s.name)
  const exitCode = unmet.length > 0 ? 1 : result.exitCode
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ exitCode, steps: result.steps })}\n`)
  } else if (unmet.length > 0) {
    const rows = result.report.split('\n').slice(0, -1)
    const red = result.steps.filter((step) => step.status === 'red').map((step) => step.name)
    const verdict = `gate: RED (${[...red, ...unmet.map((name) => `${name} skipped`)].join(', ')})`
    process.stdout.write(`${[...rows, verdict].join('\n')}\n`)
  } else {
    process.stdout.write(`${result.report}\n`)
  }
  return exitCode
}

// Real paths on both sides: run through a symlinked scripts/, the unresolved path would never match and a step's
// subcommand would exit 0 having done nothing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
