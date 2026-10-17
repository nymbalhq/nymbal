import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
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
import { newTestFiles } from './gate'
import { EXCLUDED_PREFIXES, TEST_FILE } from './test-census'

// Rule 8: a new test must be able to fail. Every test file the change adds (committed, staged or untracked) is run,
// alone, against the base commit's source in a temporary worktree, with the file copied in from the working tree.
// A file that passes there proves nothing about the change and is a violation; a run that executed no test judges
// nothing and is listed apart. The checkout being judged is never written to: the worktree is a detached one in the
// system temp directory, removed before exit, also on SIGINT and SIGTERM.

/** Every Vitest project: a new Postgres test needs NYMBAL_TEST_POSTGRES_URL in the environment, as in gate:full. */
export const DEFAULT_SUITE = 'pnpm vitest run'

export type Verdict = 'fails on base' | 'PASSES ON BASE' | 'not judged'

export type Judgement = { path: string; verdict: Verdict; note?: string }

/** Playwright journeys need running servers, which a temporary worktree of the base does not have. */
const NOT_RUNNABLE = /^tests\/e2e\//

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

function tail(text: string, count = 30): string {
  return text.trimEnd().split('\n').slice(-count).join('\n')
}

function stop(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // already gone
  }
}

export async function judge(opts: {
  root: string
  base: string
  suite: string
  /** Run in the base worktree before any test; undefined runs the base's `build` script if it has one. */
  build?: string | undefined
}): Promise<Judgement[]> {
  const root = resolve(opts.root)
  const realRoot = realpathSync(root)
  const baseSha = git(root, ['rev-parse', '--verify', `${opts.base}^{commit}`]).trim()
  const added = addedTestFiles(root, baseSha)
  if (added.length === 0) return []

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
  let created = false
  try {
    git(root, ['worktree', 'add', '--detach', '--quiet', worktree, baseSha])
    created = true
    for (const dir of nodeModulesDirs(root)) {
      const target = join(worktree, dir, 'node_modules')
      if (existsSync(target)) continue
      mirrors.push(target)
      mirrorNodeModules(join(root, dir, 'node_modules'), target, realRoot, worktree)
    }

    // Workspace packages export their built output, so the base's sources are built before they are imported.
    const build = opts.build ?? (hasBuildScript(worktree) ? 'pnpm build' : '')
    if (build !== '') {
      const built = await runCommand(worktree, build, session)
      if (session.signal !== undefined) throw new Error(`interrupted by ${session.signal}`)
      if (built.status !== 0) {
        throw new Error(
          `the base build failed (${build}: ${built.signal ?? `exit ${built.status}`}):\n${tail(built.output)}`,
        )
      }
    }

    const results: Judgement[] = []
    for (const path of added) {
      if (session.signal !== undefined) throw new Error(`interrupted by ${session.signal}`)
      if (NOT_RUNNABLE.test(path)) {
        results.push({
          path,
          verdict: 'not judged',
          note: 'a Playwright journey needs running servers',
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
    return results
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    // Remove the mirrored node_modules first: rmSync unlinks the links in them and never follows one.
    for (const mirror of mirrors) {
      if (lstatSync(mirror, { throwIfNoEntry: false }) !== undefined) {
        rmSync(mirror, { recursive: true, force: true })
      }
    }
    if (created) {
      try {
        git(root, ['worktree', 'remove', '--force', worktree])
      } catch {
        rmSync(worktree, { recursive: true, force: true })
        git(root, ['worktree', 'prune'])
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function render(results: Judgement[]): string {
  if (results.length === 0) return 'tests-fail-on-base: the change adds no test files'
  const judged = results.filter((r) => r.verdict !== 'not judged')
  const unjudged = results.filter((r) => r.verdict === 'not judged')
  const lines = judged.map((r) => `${r.verdict}: ${r.path}`)
  for (const r of unjudged) lines.push(`not judged: ${r.path} (${r.note})`)
  const violations = results.filter((r) => r.verdict === 'PASSES ON BASE').length
  lines.push(
    `tests-fail-on-base: ${results.length} added, ${violations} violation(s), ${unjudged.length} not judged`,
  )
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
  const results = await judge({ root: values.root, base, suite: values.suite, build: values.build })
  process.stdout.write(`${render(results)}\n`)
  if (results.some((r) => r.verdict === 'PASSES ON BASE')) process.exit(1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
