import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { newTestFiles } from './gate'
import { EXCLUDED_PREFIXES } from './test-census'

// Rule 8: a new test must be able to fail. Every test file the change adds is run, alone, against the base
// commit's source in a temporary worktree (with the added files copied in from HEAD). A file that passes there
// proves nothing about the change and is a violation. The checkout being judged is never written to: the worktree
// is a detached one in the system temp directory, removed before exit, also on SIGINT and SIGTERM.

/** Every Vitest project: a new Postgres test needs NYMBAL_TEST_POSTGRES_URL in the environment, as in gate:full. */
export const DEFAULT_SUITE = 'pnpm vitest run'

export type Verdict = 'fails on base' | 'PASSES ON BASE' | 'not run'

export type Judgement = { path: string; verdict: Verdict; note?: string }

/** Playwright journeys need running servers, which a temporary worktree of the base does not have. */
const NOT_RUNNABLE = /^tests\/e2e\//

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function gitBytes(root: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
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

type Session = { child?: ChildProcess; signal?: NodeJS.Signals }

function runSuite(cwd: string, command: string, session: Session): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: 'ignore' })
    session.child = child
    child.on('error', () => resolvePromise(1))
    child.on('close', (status) => {
      delete session.child
      resolvePromise(status)
    })
  })
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
}): Promise<Judgement[]> {
  const root = resolve(opts.root)
  const baseSha = git(root, ['rev-parse', '--verify', `${opts.base}^{commit}`]).trim()
  const headSha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  const added = newTestFiles(git(root, ['diff', '--name-status', baseSha, headSha])).filter(
    (path) => !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)),
  )
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
  const links: string[] = []
  let created = false
  try {
    git(root, ['worktree', 'add', '--detach', '--quiet', worktree, baseSha])
    created = true
    for (const dir of nodeModulesDirs(root)) {
      const link = join(worktree, dir, 'node_modules')
      if (existsSync(link)) continue
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(join(root, dir, 'node_modules'), link)
      links.push(link)
    }

    const results: Judgement[] = []
    for (const path of added) {
      if (session.signal !== undefined) throw new Error(`interrupted by ${session.signal}`)
      if (NOT_RUNNABLE.test(path)) {
        results.push({
          path,
          verdict: 'not run',
          note: 'a Playwright journey needs running servers',
        })
        continue
      }
      const target = join(worktree, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, gitBytes(root, ['show', `${headSha}:${path}`]))
      const status = await runSuite(worktree, `${opts.suite} ${quote(path)}`, session)
      results.push({ path, verdict: status === 0 ? 'PASSES ON BASE' : 'fails on base' })
    }
    return results
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    // Unlink the node_modules links first so that nothing removes through them.
    for (const link of links) rmSync(link, { force: true })
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
  const lines = results.map((r) =>
    r.verdict === 'not run' ? `not run: ${r.path} (${r.note})` : `${r.verdict}: ${r.path}`,
  )
  const violations = results.filter((r) => r.verdict === 'PASSES ON BASE').length
  lines.push(`tests-fail-on-base: ${results.length} added, ${violations} violation(s)`)
  return lines.join('\n')
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      suite: { type: 'string', default: DEFAULT_SUITE },
    },
  })
  const [base] = positionals
  if (base === undefined || positionals.length > 1) {
    throw new Error('usage: tests-fail-on-base.ts <base> [--root <repo>] [--suite <command>]')
  }
  const results = await judge({ root: values.root, base, suite: values.suite })
  process.stdout.write(`${render(results)}\n`)
  if (results.some((r) => r.verdict === 'PASSES ON BASE')) process.exit(1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
