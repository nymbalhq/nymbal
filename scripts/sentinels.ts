import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

// Sentinel runner. A sentinel is a known defect the test suite should catch:
//   injected: a patch that breaks behaviour. It is applied to the clean tree and the suite must go red.
//   present:  a defect that is live at HEAD. It has no patch and counts as missed until the task that fixes it
//             writes the patch that would re-introduce it.
// Every suite a sentinel will run under is run once unpatched (its control) and must be green, otherwise every
// sentinel would look caught. SIGINT or SIGTERM stops the running suite and restores the tree before exiting.

/** The default suite: every Vitest project except `tooling`, whose sentinel checks would themselves go red. */
export const DEFAULT_SUITE = 'pnpm vitest run --project !tooling'

export type Sentinel = {
  id: string
  kind: 'present' | 'injected'
  defect: string
  where: string
  killedBy: string
  suite?: string
  patch: string
}

export type SentinelResult = {
  id: string
  kind: string
  killedBy: string
  status: 'caught' | 'missed' | 'error'
  detail?: string
  durationMs: number
}

export type Report = {
  control: 'green'
  /** The suite command the run used by default; a sentinel's own `# suite:` overrides it for that sentinel. */
  suite: string
  sentinels: SentinelResult[]
  summary: {
    injected: { caught: number; total: number }
    present: { caught: number; total: number }
  }
}

const HEADER_LINE = /^# ([a-z-]+):[ \t]*(.*)$/

export function parseSentinel(text: string, file: string): Sentinel {
  const fields = new Map<string, string>()
  const lines = text.split('\n')
  let index = 0
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = HEADER_LINE.exec(line)
    if (match?.[1] !== undefined) {
      fields.set(match[1], (match[2] ?? '').trimEnd())
    } else if (line.trim() !== '') {
      break
    }
  }
  const patch = lines.slice(index).join('\n')

  const required = (name: string): string => {
    const value = fields.get(name)
    if (value === undefined || value === '') {
      throw new Error(`${file}: sentinel is missing the "# ${name}:" header`)
    }
    return value
  }

  const id = required('id')
  const kind = required('kind')
  if (kind !== 'present' && kind !== 'injected') {
    throw new Error(`${file}: "# kind:" must be "present" or "injected", got "${kind}"`)
  }
  const suite = fields.get('suite')
  return {
    id,
    kind,
    defect: required('defect'),
    where: required('where'),
    killedBy: required('killed-by'),
    ...(suite !== undefined && suite !== '' ? { suite } : {}),
    patch,
  }
}

type Exec = { status: number | null; stdout: string; stderr: string }

function git(root: string, args: string[], input?: string): Exec {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** Thrown out of `run` when SIGINT or SIGTERM arrived; the tree has been restored by then. */
export class Interrupted extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`interrupted by ${signal}`)
    this.name = 'Interrupted'
  }
}

/** Signal state for one `run`: the suite running now, and the signal that asked us to stop. */
type Session = { child?: ChildProcess; signal?: NodeJS.Signals }

const KILL_GRACE_MS = 5000

/** Stops the suite and everything it started: it runs in its own process group. */
function stopSuite(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // the group has already exited
  }
}

// The control and each sentinel run nearly the whole suite at once, where spawn-heavy tests outlast Vitest's 5 s
// default: a timeout from load alone turns the control red, or makes a sentinel look caught. Every project's timeouts
// are multiplied (vitest.config.ts); a hung test still fails, at the longer bound. A caller's own scale is kept.
const SUITE_TIMEOUT_SCALE = '3'

function runSuite(root: string, command: string, session: Session): Promise<Exec> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (session.signal !== undefined) {
      rejectPromise(new Interrupted(session.signal))
      return
    }
    const child = spawn(command, {
      cwd: root,
      env: {
        ...process.env,
        NYMBAL_TEST_TIMEOUT_SCALE: process.env['NYMBAL_TEST_TIMEOUT_SCALE'] ?? SUITE_TIMEOUT_SCALE,
      },
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    session.child = child
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolvePromise({ status: 1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (status) => {
      delete session.child
      if (session.signal !== undefined) rejectPromise(new Interrupted(session.signal))
      else resolvePromise({ status, stdout, stderr })
    })
  })
}

function tail(text: string, lines = 12): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

/** A path as git prints it in a header: bare, or C-quoted with octal escapes for non-ASCII bytes. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  const bytes: number[] = []
  const escapes: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    '\\': 92,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
  }
  for (let i = 1; i < path.length - 1; i += 1) {
    const ch = path[i] ?? ''
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const octal = /^[0-7]{3}/.exec(path.slice(i + 1))
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8))
      i += 3
    } else {
      i += 1
      bytes.push(escapes[path[i] ?? ''] ?? 92)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

const QUOTED = '"(?:[^"\\\\]|\\\\.)*"'
const GIT_HEADER = new RegExp(`^diff --git (${QUOTED}|a/.+?) (${QUOTED}|b/.+)$`)

/** `a/X b/Y` from a `diff --git` line as [X, Y]; the even split wins when a path itself contains " b/". */
function headerPaths(rest: string): [string, string] | undefined {
  const half = (rest.length - 5) / 2
  if (rest.startsWith('a/') && Number.isInteger(half)) {
    const left = rest.slice(2, 2 + half)
    if (rest.slice(2 + half) === ` b/${left}`) return [left, left]
  }
  const match = GIT_HEADER.exec(`diff --git ${rest}`)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const strip = (p: string): string => unquote(p).replace(/^[ab]\//, '')
  return [strip(match[1]), strip(match[2])]
}

/** Paths a git patch touches, from its `diff --git a/X b/Y` headers only; hunk lines are never read as paths. */
export function touchedPaths(patch: string): Set<string> {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue
    const pair = headerPaths(line.slice('diff --git '.length))
    if (pair === undefined) throw new Error(`cannot read the paths of "${line}"`)
    for (const path of pair) paths.add(path)
  }
  return paths
}

/** Puts back every file the patch touched: tracked files from HEAD, files the patch created are removed. */
function restore(root: string, paths: Set<string>): void {
  for (const path of paths) {
    const tracked = git(root, ['ls-files', '--error-unmatch', '--', path]).status === 0
    if (tracked) {
      git(root, ['checkout', 'HEAD', '--', path])
    } else {
      rmSync(join(root, path), { force: true })
    }
  }
}

export function loadSentinels(dir: string): Sentinel[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.patch'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => parseSentinel(readFileSync(join(dir, name), 'utf8'), join(dir, name)))
}

async function runOne(
  root: string,
  sentinel: Sentinel,
  defaultSuite: string,
  session: Session,
): Promise<SentinelResult> {
  const started = Date.now()
  const result = (status: SentinelResult['status'], detail?: string): SentinelResult => ({
    id: sentinel.id,
    kind: sentinel.kind,
    killedBy: sentinel.killedBy,
    status,
    ...(detail !== undefined ? { detail } : {}),
    durationMs: Date.now() - started,
  })

  if (sentinel.kind === 'present') {
    return result('missed', 'live defect: nothing to apply, the control suite is green')
  }

  const patch = sentinel.patch.endsWith('\n') ? sentinel.patch : `${sentinel.patch}\n`
  let paths: Set<string>
  try {
    paths = touchedPaths(patch)
  } catch (error) {
    return result('error', error instanceof Error ? error.message : String(error))
  }
  if (paths.size === 0) {
    return result('error', 'patch has no "diff --git" header, so it cannot be restored')
  }
  const check = git(root, ['apply', '--check', '-'], patch)
  if (check.status !== 0) return result('error', `patch does not apply: ${tail(check.stderr)}`)

  const applied = git(root, ['apply', '-'], patch)
  if (applied.status !== 0) {
    restore(root, paths)
    return result('error', `patch does not apply: ${tail(applied.stderr)}`)
  }
  try {
    const suite = await runSuite(root, sentinel.suite ?? defaultSuite, session)
    return suite.status === 0
      ? result('missed', 'the suite stayed green with the defect applied')
      : result('caught', tail(`${suite.stdout}\n${suite.stderr}`))
  } finally {
    restore(root, paths)
  }
}

function summarise(results: SentinelResult[]): Report['summary'] {
  const count = (kind: string): { caught: number; total: number } => {
    const counted = results.filter((r) => r.kind === kind && r.status !== 'error')
    return { caught: counted.filter((r) => r.status === 'caught').length, total: counted.length }
  }
  return { injected: count('injected'), present: count('present') }
}

export async function run(opts: {
  root: string
  dir: string
  suite: string
  /** One id, or several; an id with no sentinel is an error before anything runs. */
  only?: string | string[]
}): Promise<Report> {
  const root = resolve(opts.root)
  const dir = resolve(opts.dir)

  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty.status !== 0) throw new Error(`not a git work tree: ${root}: ${tail(dirty.stderr)}`)
  if (dirty.stdout.trim() !== '') {
    throw new Error(
      `refusing to run: tracked files have uncommitted changes\n${dirty.stdout.trimEnd()}`,
    )
  }

  const all = loadSentinels(dir)
  const only = opts.only === undefined ? undefined : [opts.only].flat()
  if (only !== undefined && only.length === 0) throw new Error('--only names no sentinel')
  const unknown = (only ?? []).filter((id) => !all.some((s) => s.id === id))
  if (unknown.length > 0) {
    throw new Error(`no sentinel with id ${unknown.join(', ')} in ${dir}`)
  }
  const selected = only === undefined ? all : all.filter((s) => only.includes(s.id))

  const session: Session = {}
  const onSignal = (signal: NodeJS.Signals): void => {
    const again = session.signal !== undefined
    session.signal = signal
    if (session.child) stopSuite(session.child, again ? 'SIGKILL' : 'SIGTERM')
    if (!again && session.child) {
      const child = session.child
      setTimeout(() => stopSuite(child, 'SIGKILL'), KILL_GRACE_MS).unref()
    }
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    const suites = new Set([opts.suite, ...selected.flatMap((s) => (s.suite ? [s.suite] : []))])
    for (const suite of suites) {
      const control = await runSuite(root, suite, session)
      if (control.status !== 0) {
        throw new Error(
          `control red: "${suite}" fails without any sentinel applied\n${tail(`${control.stdout}\n${control.stderr}`)}`,
        )
      }
    }

    const results: SentinelResult[] = []
    for (const sentinel of selected) {
      results.push(await runOne(root, sentinel, opts.suite, session))
    }
    if (session.signal !== undefined) throw new Interrupted(session.signal)
    return { control: 'green', suite: opts.suite, sentinels: results, summary: summarise(results) }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

function renderReport(report: Report): string {
  const lines = ['| id | kind | status | killed by | ms |', '|---|---|---|---|---:|']
  for (const s of report.sentinels) {
    lines.push(`| ${s.id} | ${s.kind} | ${s.status} | ${s.killedBy} | ${s.durationMs} |`)
  }
  const { injected, present } = report.summary
  lines.push(
    '',
    `Suite: ${report.suite}`,
    `Control: ${report.control}`,
    `Injected: ${injected.caught}/${injected.total} caught`,
    `Present: ${present.caught}/${present.total} caught`,
  )
  return lines.join('\n')
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: '.' },
      dir: { type: 'string' },
      suite: { type: 'string', default: DEFAULT_SUITE },
      only: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const root = resolve(values.root)
  const dir = values.dir === undefined ? join(root, 'tests/sentinels') : resolve(values.dir)
  if (!existsSync(dir)) throw new Error(`sentinel directory not found: ${dir}`)
  const report = await run({
    root,
    dir,
    suite: values.suite,
    ...(values.only !== undefined
      ? {
          only: values.only
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        }
      : {}),
  })
  process.stdout.write(`${values.json ? JSON.stringify(report) : renderReport(report)}\n`)
  // A red control throws from run(). An injected sentinel that is missed, or errors because its patch no longer
  // applies, proves nothing caught it: the run fails, after the report.
  if (report.sentinels.some((s) => s.kind === 'injected' && s.status !== 'caught')) {
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof Interrupted) {
      process.stderr.write(`${error.message}: the tree is restored\n`)
      process.exit(130)
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
