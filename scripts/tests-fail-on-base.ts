import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { changedFiles, newTestFiles } from './gate'
import { loadSentinels, type Sentinel } from './sentinels'
import { EXCLUDED_PREFIXES, TEST_FILE } from './test-census'

// Rule 8: a new test must be able to fail. Every test file the change adds (committed, staged or untracked) is run,
// alone, against the base commit's source in a temporary worktree, with the file copied in from the working tree.
// A file that passes there proves nothing about the change and is a violation; a run that executed no test judges
// nothing and is listed apart. The checkout being judged is never written to: the worktree is a detached one in the
// system temp directory, removed before exit, also on SIGINT and SIGTERM. When a manifest or the lockfile differs
// from the base's, the worktree installs the base's own dependencies. When that or the base's build fails, no file is
// judged and the step fails closed with the first error line and the output's tail: a change must not be able to
// opt out of the rule by breaking the base's install.
// A file can pass on the base by design when it guards correct code against a known defect. A file that passes on
// the base and is named in the `# suite:` of an injected sentinel under `tests/sentinels/` is run once more, alone, in
// a second temporary worktree of HEAD with that sentinel's patch applied: failing there is `fails under sentinel <id>`
// and no violation; passing there, or being named by no sentinel, stays PASSES ON BASE.

/**
 * Every Vitest project: a new Postgres or Mailpit test needs NYMBAL_TEST_POSTGRES_URL or NYMBAL_TEST_MAILPIT_URL in
 * the environment, as in gate:full, or it fails on base for want of the server and proves nothing.
 */
export const DEFAULT_SUITE = 'pnpm vitest run'

export type Verdict = 'fails on base' | 'PASSES ON BASE' | 'fails under sentinel' | 'not judged'

/** `sentinel` is the id of the injected sentinel whose patch made the file fail, with `fails under sentinel`. */
export type Judgement = { path: string; verdict: Verdict; note?: string; sentinel?: string }

/** Why the base could not be judged against: the first error line of the failing command, and its output's tail. */
export type BaseFailure = { reason: string; tail: string[] }

export type Report = { results: Judgement[]; baseFailure?: BaseFailure }

/**
 * Playwright journeys and the scaffold check need running servers (the scaffold check a published, scaffolded store
 * too), which a temporary worktree of the base does not have.
 */
const NOT_RUNNABLE = /^tests\/(e2e|scaffold)\//

/** Suite output that means the base run collected no test, so its exit code says nothing about the file. */
const NOTHING_RAN: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /No test files found/, note: 'the base configuration collects no such test file' },
  {
    pattern: /No projects matched the filter/,
    note: 'the suite names a project the base does not have',
  },
]

/**
 * Vitest's own summary of the files it ran. A test that runs Vitest itself can quote a NOTHING_RAN phrase in its
 * failure message, so the phrases count only when the run collected nothing.
 */
const RAN_SUMMARY = /^\s*Test Files\s+\d/m

const ANSI = /\x1b\[[0-9;]*m/g

/** Caches a run writes into: created fresh in the worktree so that HEAD's node_modules is never written. */
const RUN_CACHES = new Set(['.cache', '.vite'])

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

/** The test files the working tree adds over the base: committed, staged or untracked (and not ignored). */
function addedTestFiles(root: string, base: string): string[] {
  const tracked = newTestFiles(git(root, ['diff', '--name-status', base]))
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter((path) => path !== '' && TEST_FILE.test(path))
  return [...new Set([...tracked, ...untracked])]
    .filter((path) => !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .sort()
}

/** Directories holding a `node_modules`: the root and each workspace directory one level below a top-level folder. */
function nodeModulesDirs(root: string): string[] {
  const dirs: string[] = []
  const has = (dir: string): boolean => existsSync(join(root, dir, 'node_modules'))
  if (has('.')) dirs.push('.')
  for (const top of readdirSync(root, { withFileTypes: true })) {
    if (!top.isDirectory() || top.name === '.git' || top.name === 'node_modules') continue
    if (has(top.name)) dirs.push(top.name)
    for (const child of readdirSync(join(root, top.name), { withFileTypes: true })) {
      if (child.isDirectory() && child.name !== 'node_modules' && has(join(top.name, child.name))) {
        dirs.push(join(top.name, child.name))
      }
    }
  }
  return dirs
}

/** The path of `real` inside the repository's own sources, or undefined when it is outside or in a node_modules. */
function workspacePath(realRoot: string, real: string): string | undefined {
  const rel = relative(realRoot, real)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep).includes('node_modules') ? undefined : rel
}

/**
 * Fills the worktree's `target` node_modules from HEAD's `source`: a workspace package (a link into the repository's
 * sources) links to the same package in the worktree, so it resolves to the base's code; everything else links to
 * HEAD's installed copy. Scope folders are real directories, so that their workspace entries can differ.
 */
function mirrorNodeModules(
  source: string,
  target: string,
  realRoot: string,
  worktree: string,
): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (RUN_CACHES.has(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      mirrorNodeModules(from, to, realRoot, worktree)
      continue
    }
    const inRepo =
      entry.isSymbolicLink() && existsSync(from)
        ? workspacePath(realRoot, realpathSync(from))
        : undefined
    symlinkSync(inRepo === undefined ? from : join(worktree, inRepo), to)
  }
}

function hasBuildScript(dir: string): boolean {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return false
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> }
  return typeof pkg.scripts?.build === 'string'
}

type Session = { child?: ChildProcess; signal?: NodeJS.Signals }

type SuiteRun = { status: number | null; signal: NodeJS.Signals | null; output: string }

function runCommand(cwd: string, command: string, session: Session): Promise<SuiteRun> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    session.child = child
    let output = ''
    const collect = (chunk: Buffer): void => {
      output += chunk.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      delete session.child
      resolvePromise({ status: 1, signal: null, output: `${output}${error.message}` })
    })
    child.on('close', (status, signal) => {
      delete session.child
      resolvePromise({ status, signal, output })
    })
  })
}

/** The verdict a base run gives: no test executed is no judgement, else its exit code decides. */
function verdictOf(run: SuiteRun): { verdict: Verdict; note?: string } {
  // A shell reports a child killed by signal n as 128 + n.
  const bySignal = run.signal !== null || (run.status !== null && run.status > 128)
  if (bySignal) {
    const name = run.signal ?? `exit ${run.status}`
    return { verdict: 'not judged', note: `the base run ended by a signal (${name})` }
  }
  const output = run.output.replace(ANSI, '')
  const nothing = RAN_SUMMARY.test(output)
    ? undefined
    : NOTHING_RAN.find(({ pattern }) => pattern.test(output))
  if (nothing !== undefined) return { verdict: 'not judged', note: nothing.note }
  return { verdict: run.status === 0 ? 'PASSES ON BASE' : 'fails on base' }
}

/** The shapes tsc, pnpm and Node print for a real error; words like `error` in a file name or a warning are not. */
const ERROR_SHAPES = [
  /\berror TS\d+/,
  /\bERR_PNPM_\w+/,
  /^Error(?: \[\w+\])?:/,
  /Cannot find (?:module|package)/,
]

function outputLines(output: string): string[] {
  return output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
}

/** The first output line of a real error shape; else the last non-empty line; else a placeholder. Trimmed. */
export function firstErrorLine(output: string): string {
  const all = outputLines(output)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return (
    all.find((line) => ERROR_SHAPES.some((shape) => shape.test(line))) ??
    all[all.length - 1] ??
    'no output'
  )
}

const TAIL_LINES = 20

/** The last lines of a command's output, blank lines at the end dropped. */
function tailOf(output: string): string[] {
  const all = outputLines(output)
  while (all.length > 0 && all[all.length - 1] === '') all.pop()
  return all.slice(-TAIL_LINES)
}

/**
 * Whether a changed path moves the dependency graph: a `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or
 * `.npmrc` at any depth, or anything under the root `patches/`.
 */
export function isDependencyLayoutPath(path: string): boolean {
  return (
    /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/.test(path) ||
    path.startsWith('patches/')
  )
}

function dependenciesChanged(root: string, base: string): boolean {
  return changedFiles(root, base).some(isDependencyLayoutPath)
}

/** pnpm errors about the lockfile itself: the registry cannot fix them, so an online retry only wastes time. */
const UNFIXABLE_ONLINE = /\bERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_\w+)/

type Run = (cwd: string, command: string, session: Session) => Promise<SuiteRun>

/** Installs the base's own dependencies: from the local store, else online when going online can help. */
export async function installBase(
  worktree: string,
  session: Session,
  run: Run = runCommand,
): Promise<SuiteRun> {
  const offline = await run(worktree, 'pnpm install --frozen-lockfile --offline', session)
  if (offline.status === 0 || session.signal !== undefined) return offline
  if (UNFIXABLE_ONLINE.test(offline.output.replace(ANSI, ''))) return offline
  return run(worktree, 'pnpm install --frozen-lockfile', session)
}

const BASE_DID_NOT_BUILD = 'base did not build: '

function stop(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // already gone
  }
}

/** Whether a sentinel's `# suite:` command names `path` as one of its words, quoted or not. */
function suiteNames(suite: string, path: string): boolean {
  return suite
    .split(/\s+/)
    .some((word) => word.replace(/^(['"])(.*)\1$/, '$2').replace(/^\.\//, '') === path)
}

/** The injected sentinels under the checkout's `tests/sentinels/` whose `# suite:` names one of `paths`. */
function namingSentinels(root: string, paths: string[]): Sentinel[] {
  const dir = join(root, 'tests', 'sentinels')
  if (!existsSync(dir)) return []
  return loadSentinels(dir).filter((sentinel) => {
    const suite = sentinel.suite
    return (
      sentinel.kind === 'injected' &&
      suite !== undefined &&
      paths.some((path) => suiteNames(suite, path))
    )
  })
}

/** Applies a sentinel's patch to a worktree, or takes it back out; the first error line when git refuses. */
function applyPatch(worktree: string, patch: string, reverse: boolean): string | undefined {
  const applied = spawnSync('git', ['apply', ...(reverse ? ['-R'] : []), '-'], {
    cwd: worktree,
    input: patch.endsWith('\n') ? patch : `${patch}\n`,
    encoding: 'utf8',
  })
  return applied.status === 0 ? undefined : firstErrorLine(`${applied.stdout}${applied.stderr}`)
}

/**
 * Runs each PASSES ON BASE file a sentinel names once more, alone, in `worktree` (HEAD's source) with that sentinel's
 * patch applied, and marks it `fails under sentinel <id>` when it fails there. Each patch is taken back out before
 * the next sentinel, so every sentinel is judged against HEAD's own source.
 */
async function judgeUnderSentinels(
  results: Judgement[],
  sentinels: Sentinel[],
  head: { root: string; worktree: string; build: string; suite: string; session: Session },
): Promise<void> {
  for (const sentinel of sentinels) {
    const suite = sentinel.suite ?? ''
    const named = results.filter((r) => r.verdict === 'PASSES ON BASE' && suiteNames(suite, r.path))
    if (named.length === 0) continue
    const refused = applyPatch(head.worktree, sentinel.patch, false)
    if (refused !== undefined) {
      for (const r of named) r.note = `sentinel ${sentinel.id} does not apply to HEAD: ${refused}`
      continue
    }
    try {
      if (head.build !== '') {
        const built = await runCommand(head.worktree, head.build, head.session)
        if (head.session.signal !== undefined) {
          throw new Error(`interrupted by ${head.session.signal}`)
        }
        if (built.status !== 0) {
          const reason = firstErrorLine(built.output)
          for (const r of named)
            r.note = `HEAD did not build under sentinel ${sentinel.id}: ${reason}`
          continue
        }
      }
      for (const r of named) {
        const target = join(head.worktree, r.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readFileSync(join(head.root, r.path)))
        const run = await runCommand(head.worktree, `${head.suite} ${quote(r.path)}`, head.session)
        if (head.session.signal !== undefined) {
          throw new Error(`interrupted by ${head.session.signal}`)
        }
        const { verdict, note } = verdictOf(run)
        if (verdict === 'fails on base') {
          r.verdict = 'fails under sentinel'
          r.sentinel = sentinel.id
          delete r.note
        } else {
          r.note =
            verdict === 'PASSES ON BASE'
              ? `passes under sentinel ${sentinel.id} too`
              : `no verdict under sentinel ${sentinel.id}: ${note}`
        }
      }
    } finally {
      const stuck = applyPatch(head.worktree, sentinel.patch, true)
      if (stuck !== undefined) {
        throw new Error(
          `sentinel ${sentinel.id} could not be taken back out of HEAD's worktree: ${stuck}`,
        )
      }
    }
  }
}

export async function judge(opts: {
  root: string
  base: string
  suite: string
  /** Run in the base worktree before any test; undefined runs the base's `build` script if it has one. */
  build?: string | undefined
}): Promise<Report> {
  const root = resolve(opts.root)
  const realRoot = realpathSync(root)
  const baseSha = git(root, ['rev-parse', '--verify', `${opts.base}^{commit}`]).trim()
  const added = addedTestFiles(root, baseSha)
  if (added.length === 0) return { results: [] }

  const session: Session = {}
  const onSignal = (signal: NodeJS.Signals): void => {
    session.signal = signal
    if (session.child) stop(session.child, 'SIGTERM')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const scratch = mkdtempSync(join(tmpdir(), 'nymbal-tfob-'))
  const worktree = join(scratch, 'base')
  const mirrors: string[] = []
  const worktrees: string[] = []
  const addWorktree = (path: string, sha: string): void => {
    git(root, ['worktree', 'add', '--detach', '--quiet', path, sha])
    worktrees.push(path)
  }
  const mirrorInto = (tree: string): void => {
    for (const dir of nodeModulesDirs(root)) {
      const target = join(tree, dir, 'node_modules')
      if (existsSync(target)) continue
      mirrors.push(target)
      mirrorNodeModules(join(root, dir, 'node_modules'), target, realRoot, tree)
    }
  }
  const buildOf = (tree: string): string => opts.build ?? (hasBuildScript(tree) ? 'pnpm build' : '')
  try {
    addWorktree(worktree, baseSha)
    // HEAD's modules cannot stand in for the base's when a manifest or the lockfile moved (a renamed dependency).
    const installs = dependenciesChanged(root, baseSha)
    if (!installs) mirrorInto(worktree)

    // A base that cannot install or build judges no test, and the step fails: the rule is never skipped silently.
    const notBuilt = (output: string): Report => {
      const reason = firstErrorLine(output)
      return {
        results: added.map((path) => ({
          path,
          verdict: 'not judged',
          note: `${BASE_DID_NOT_BUILD}${reason}`,
        })),
        baseFailure: { reason, tail: tailOf(output) },
      }
    }

    if (installs) {
      const installed = await installBase(worktree, session)
      if (session.signal !== undefined) throw new Error(`interrupted by ${session.signal}`)
      if (installed.status !== 0) return notBuilt(installed.output)
    }

    // Workspace packages export their built output, so the base's sources are built before they are imported.
    const build = buildOf(worktree)
    if (build !== '') {
      const built = await runCommand(worktree, build, session)
      if (session.signal !== undefined) throw new Error(`interrupted by ${session.signal}`)
      if (built.status !== 0) return notBuilt(built.output)
    }

    const results: Judgement[] = []
    for (const path of added) {
      if (session.signal !== undefined) throw new Error(`interrupted by ${session.signal}`)
      if (NOT_RUNNABLE.test(path)) {
        results.push({
          path,
          verdict: 'not judged',
          note: 'a Playwright journey or the scaffold check needs running servers',
        })
        continue
      }
      const target = join(worktree, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readFileSync(join(root, path)))
      const run = await runCommand(worktree, `${opts.suite} ${quote(path)}`, session)
      if (session.signal !== undefined) throw new Error(`interrupted by ${session.signal}`)
      results.push({ path, ...verdictOf(run) })
    }

    const passing = results.filter((r) => r.verdict === 'PASSES ON BASE').map((r) => r.path)
    const sentinels = passing.length === 0 ? [] : namingSentinels(root, passing)
    if (sentinels.length > 0) {
      // A sentinel's patch is written against HEAD's source, so it runs in a worktree of HEAD with HEAD's modules.
      const head = join(scratch, 'head')
      addWorktree(head, git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim())
      mirrorInto(head)
      await judgeUnderSentinels(results, sentinels, {
        root,
        worktree: head,
        build: buildOf(head),
        suite: opts.suite,
        session,
      })
    }
    return { results }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    // Remove the mirrored node_modules first: rmSync unlinks the links in them and never follows one.
    for (const mirror of mirrors) {
      if (lstatSync(mirror, { throwIfNoEntry: false }) !== undefined) {
        rmSync(mirror, { recursive: true, force: true })
      }
    }
    for (const tree of worktrees) {
      try {
        git(root, ['worktree', 'remove', '--force', tree])
      } catch {
        rmSync(tree, { recursive: true, force: true })
        git(root, ['worktree', 'prune'])
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function render({ results, baseFailure }: Report): string {
  if (results.length === 0) return 'tests-fail-on-base: the change adds no test files'
  const judged = results.filter((r) => r.verdict !== 'not judged')
  const unjudged = results.filter((r) => r.verdict === 'not judged')
  const lines = judged.map((r) => {
    const verdict = r.verdict === 'fails under sentinel' ? `${r.verdict} ${r.sentinel}` : r.verdict
    return `${verdict}: ${r.path}${r.note === undefined ? '' : ` (${r.note})`}`
  })
  for (const r of unjudged) lines.push(`not judged: ${r.path} (${r.note})`)
  const violations = results.filter((r) => r.verdict === 'PASSES ON BASE').length
  lines.push(
    `tests-fail-on-base: ${results.length} added, ${violations} violation(s), ${unjudged.length} not judged`,
  )
  if (baseFailure !== undefined) {
    lines.push(
      `failed: ${BASE_DID_NOT_BUILD}${baseFailure.reason}; the last ${baseFailure.tail.length} line(s) of its output:`,
      ...baseFailure.tail.map((line) => `  | ${line}`),
    )
  }
  return lines.join('\n')
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      suite: { type: 'string', default: DEFAULT_SUITE },
      build: { type: 'string' },
    },
  })
  const [base] = positionals
  if (base === undefined || positionals.length > 1) {
    throw new Error(
      'usage: tests-fail-on-base.ts <base> [--root <repo>] [--suite <command>] [--build <command>, "" for none]',
    )
  }
  const report = await judge({ root: values.root, base, suite: values.suite, build: values.build })
  process.stdout.write(`${render(report)}\n`)
  const violated = report.results.some((r) => r.verdict === 'PASSES ON BASE')
  if (violated || report.baseFailure !== undefined) process.exit(1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
