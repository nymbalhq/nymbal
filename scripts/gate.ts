import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  aggregate,
  classifySource,
  EXCLUDED_PREFIXES,
  type FileCensus,
  TEST_FILE,
  type Totals,
} from './test-census'

// The gate: one command to run before finishing (`pnpm gate`) and one before a pull request (`pnpm gate:full`).
// Every step is a shell command whose exit code decides its status; the verdict is red if and only if a step is
// red, and every step runs even after a red one (except those that need a step that is not ok).

export type StepStatus = 'ok' | 'red' | 'skipped'

export type Step = { name: string; status: StepStatus; ms: number; detail?: string }

/** A step to run. `skip` names the reason to leave it out; `needs` skips it unless every named step is ok. */
export type StepSpec = { name: string; command: string; skip?: string; needs?: string[] }

export type RunOptions = {
  cwd: string
  budgetMs: number
  /** Progress and the output of red steps, as they happen. */
  log?: (text: string) => void
  env?: NodeJS.ProcessEnv
}

export type RunResult = { exitCode: number; steps: Step[]; report: string }

export const GATE_BUDGET_MS = 60_000
export const FULL_BUDGET_MS = 600_000
export const POSTGRES_URL = 'postgres://postgres:nymbal@localhost:54329/nymbal'

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

const ASSERTION_CALL = /expect\(|assert\.|fc\.assert/

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
 * Whether the change writes assertions in `path`, from a unified `git diff -M` that may cover several files: the file
 * is new, or an added line in its own hunks contains an assertion call. Context lines, headers and other files'
 * hunks never count, and a file that only moved is not new.
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
      } else if (line.startsWith('+') && ASSERTION_CALL.test(line)) {
        return true
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

/** Runs the steps in order, each as a shell command in `cwd`; a red step does not stop the later ones. */
export async function run(steps: StepSpec[], opts: RunOptions): Promise<RunResult> {
  const results: Step[] = []
  const log = opts.log ?? ((): void => {})
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
    log(`running ${spec.name}: ${spec.command}\n`)
    const started = performance.now()
    const { code, output } = await execute(spec.command, opts.cwd, opts.env)
    const ms = Math.round(performance.now() - started)
    if (code === 0) {
      results.push({ name: spec.name, status: 'ok', ms })
    } else {
      results.push({ name: spec.name, status: 'red', ms, detail: `exit ${code}` })
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
    assertionResults?: Array<{ fullName?: string; title?: string; duration?: number | null }>
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

/** Changed files that fall inside Stryker's `mutate` set (its own config is the source of that set). */
async function mutateSet(root: string, changed: string[]): Promise<string[]> {
  const config = (await import(pathToFileURL(resolve(root, 'stryker.config.mjs')).href)) as {
    default: { mutate: string[] }
  }
  const include = config.default.mutate.filter((g) => !g.startsWith('!')).map(globToRegExp)
  const exclude = config.default.mutate
    .filter((g) => g.startsWith('!'))
    .map((g) => globToRegExp(g.slice(1)))
  return changed.filter(
    (path) => include.some((re) => re.test(path)) && !exclude.some((re) => re.test(path)),
  )
}

export type PlanInput = { full: boolean; base: string; changed: string[]; mutated: string[] }

const SCRIPT = 'node_modules/.bin/tsx scripts/gate.ts'

export function plan(input: PlanInput): { steps: StepSpec[]; budgetMs: number } {
  const { full, base, changed, mutated } = input
  const selection = full
    ? { mode: 'all' as const, reason: 'gate:full runs every test' }
    : selectTests(changed)
  const tests: StepSpec =
    selection.mode === 'none'
      ? { name: 'tests', command: 'true', skip: selection.reason }
      : selection.mode === 'changed'
        ? { name: 'tests', command: `pnpm run test --changed ${base} --passWithNoTests` }
        : {
            name: 'tests',
            command: full
              ? 'pnpm run test --reporter=default --reporter=json --outputFile.json=reports/vitest.json'
              : 'pnpm test',
          }
  const steps: StepSpec[] = [
    { name: 'lint', command: 'pnpm lint' },
    { name: 'typecheck', command: 'pnpm typecheck' },
    tests,
    { name: 'census trend', command: `${SCRIPT} census-trend ${base}` },
  ]
  if (!full) return { steps, budgetMs: GATE_BUDGET_MS }

  const postgres = `NYMBAL_TEST_POSTGRES_URL=${POSTGRES_URL}`
  steps.push(
    { name: 'compose up', command: 'docker compose up -d --wait' },
    { name: 'build', command: 'pnpm build' },
    {
      name: 'integration-postgres',
      command: `${postgres} pnpm exec vitest run --project integration-postgres`,
      needs: ['compose up'],
    },
    mutated.length === 0
      ? { name: 'stryker', command: 'true', skip: "no changed file in Stryker's mutate set" }
      : { name: 'stryker', command: `pnpm exec stryker run --mutate '${mutated.join(',')}'` },
    { name: 'sentinels', command: 'pnpm sentinels' },
    {
      name: 'tests-fail-on-base',
      command: `${postgres} node_modules/.bin/tsx scripts/tests-fail-on-base.ts ${base}`,
      needs: ['compose up'],
    },
    // The journeys run against the built packages and the composed services: without both they test nothing new.
    {
      name: 'e2e',
      command:
        'CI=1 pnpm --filter @nymbal/e2e exec playwright test --project astro --project nextjs --grep-invert @visual',
      needs: ['build', 'compose up'],
    },
    {
      name: 'e2e admin',
      command:
        'CI=1 NYMBAL_E2E_ADMIN=true pnpm --filter @nymbal/e2e exec playwright test --project admin --grep-invert @visual',
      needs: ['build', 'compose up'],
    },
  )
  return { steps, budgetMs: FULL_BUDGET_MS }
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
    },
  })
  const root = repoRoot()
  const [subcommand, subBase] = positionals
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

  const base = resolveBase(root, values.base)
  const startedMs = Date.now()
  const changed = changedFiles(root, base)
  // A deleted file has nothing left to mutate.
  const present = changed.filter((path) => existsSync(resolve(root, path)))
  const mutated = values.full ? await mutateSet(root, present) : []
  const { steps, budgetMs } = plan({ full: values.full, base, changed, mutated })
  if (values.full) {
    // The report reads what the steps above wrote, so it runs last and is part of the verdict.
    steps.push({
      name: 'test-quality report',
      command: `${SCRIPT} test-quality ${base} --started ${startedMs}`,
    })
  }
  const log = (text: string): void => {
    process.stderr.write(text)
  }
  const result = await run(steps, { cwd: root, budgetMs, log })
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ exitCode: result.exitCode, steps: result.steps })}\n`)
  } else {
    process.stdout.write(`${result.report}\n`)
  }
  return result.exitCode
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
