import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

// Sentinel runner. A sentinel is a known defect the test suite should catch:
//   injected: a patch that breaks behaviour. It is applied to the clean tree and the suite must go red.
//   present:  a defect that is live at HEAD. It has no patch and counts as missed until the task that fixes it
//             writes the patch that would re-introduce it.
// The suite is run once unpatched (the control) and must be green, otherwise every sentinel would look caught.

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

function runSuite(root: string, command: string): Promise<Exec> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
      resolvePromise({ status, stdout, stderr })
    })
  })
}

function tail(text: string, lines = 12): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

/** Paths a unified diff touches, from its `+++`/`---` lines. */
function touchedPaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const match = /^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/.exec(line)
    if (match?.[1] !== undefined && match[1] !== '/dev/null') paths.add(match[1])
  }
  return [...paths]
}

/** Puts back every file the patch touched: tracked files from HEAD, files the patch created are removed. */
function restore(root: string, patch: string): void {
  for (const path of touchedPaths(patch)) {
    const tracked = git(root, ['ls-files', '--error-unmatch', '--', path]).status === 0
    if (tracked) {
      git(root, ['checkout', 'HEAD', '--', path])
    } else {
      rmSync(join(root, path), { force: true })
    }
  }
}

function loadSentinels(dir: string): Sentinel[] {
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
  const check = git(root, ['apply', '--check', '-'], patch)
  if (check.status !== 0) return result('error', `patch does not apply: ${tail(check.stderr)}`)

  const applied = git(root, ['apply', '-'], patch)
  if (applied.status !== 0) {
    restore(root, patch)
    return result('error', `patch does not apply: ${tail(applied.stderr)}`)
  }
  try {
    const suite = await runSuite(root, sentinel.suite ?? defaultSuite)
    return suite.status === 0
      ? result('missed', 'the suite stayed green with the defect applied')
      : result('caught', tail(`${suite.stdout}\n${suite.stderr}`))
  } finally {
    restore(root, patch)
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
  only?: string
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
  const selected = opts.only === undefined ? all : all.filter((s) => s.id === opts.only)
  if (opts.only !== undefined && selected.length === 0) {
    throw new Error(`no sentinel with id ${opts.only} in ${dir}`)
  }

  const control = await runSuite(root, opts.suite)
  if (control.status !== 0) {
    throw new Error(
      `control red: "${opts.suite}" fails without any sentinel applied\n${tail(`${control.stdout}\n${control.stderr}`)}`,
    )
  }

  const results: SentinelResult[] = []
  for (const sentinel of selected) {
    results.push(await runOne(root, sentinel, opts.suite))
  }
  return { control: 'green', sentinels: results, summary: summarise(results) }
}

function renderReport(report: Report): string {
  const lines = ['| id | kind | status | killed by | ms |', '|---|---|---|---|---:|']
  for (const s of report.sentinels) {
    lines.push(`| ${s.id} | ${s.kind} | ${s.status} | ${s.killedBy} | ${s.durationMs} |`)
  }
  const { injected, present } = report.summary
  lines.push(
    '',
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
      suite: { type: 'string', default: 'pnpm test' },
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
    ...(values.only !== undefined ? { only: values.only } : {}),
  })
  process.stdout.write(`${values.json ? JSON.stringify(report) : renderReport(report)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
