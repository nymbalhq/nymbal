import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Manifest, type ManifestEntry, REPO, validateManifest } from './manifest'
import { badgePath, renderBadge, renderStatusPage } from './site'
import { type EntryHistory, nextStatus, type RunResult } from './status'

// The nightly registry run: certifies each third-party entry of the manifest with the workspace CLI, carries each
// entry's status in the history file, and writes the status page. A listed package's code runs only in a container
// that holds no environment, no network while certifying, and only its own project writable.

const IMAGE = `node:${readFileSync(join(REPO, '.node-version'), 'utf8').trim()}-bookworm-slim`
const CLI_BIN = join(REPO, 'packages', 'cli', 'bin', 'nymbal.mjs')
const CLI_DIST = join(REPO, 'packages', 'cli', 'dist', 'index.js')
const CONTRACT_TESTS = join(REPO, 'packages', 'contract-tests')
const OUTPUT_LIMIT = 64 * 1024 * 1024

class RunError extends Error {}

const lastLine = (text: string): string =>
  text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? ''

/** Runs one command in a fresh container; past `timeoutS` the container is killed and the result says so. */
function sandbox(
  project: string,
  command: string[],
  opts: { network: boolean; timeoutS: number },
): { status: number | null; out: string; timedOut: boolean } {
  const name = `nymbal-registry-${randomBytes(6).toString('hex')}`
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    '2g',
    // The host's user, so the container writes its project as the host would, and root's file rights are not needed.
    '--user',
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    ...(opts.network ? [] : ['--network', 'none']),
    '--volume',
    `${project}:${project}`,
    '--volume',
    `${REPO}:${REPO}:ro`,
    '--workdir',
    project,
    IMAGE,
    ...command,
  ]
  const res = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: opts.timeoutS * 1000,
    // The client proxies a SIGTERM to the container and waits on it, which a spinning adapter never answers.
    killSignal: 'SIGKILL',
    maxBuffer: OUTPUT_LIMIT,
  })
  const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  // A client that died on its own (a timeout, output past the limit) leaves the --rm container running.
  if (res.error) spawnSync('docker', ['kill', name], { encoding: 'utf8', timeout: 60_000 })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error && !timedOut ? res.error.message : ''}`
  // Docker's own failures (125: the daemon or run options; 126, 127: the image's npm or node not runnable) are the
  // run's, not the adapter's: charging them to every entry would suspend adapters that did nothing wrong.
  if (res.status === 125 || res.status === 126 || res.status === 127) {
    throw new RunError(`docker run exited ${res.status}: ${lastLine(out)}`)
  }
  return { status: res.status, out, timedOut }
}

function npmErrorLine(out: string): string {
  const first = out.split('\n').find((l) => l.startsWith('npm error') || l.startsWith('npm ERR!'))
  return first?.trim() ?? lastLine(out)
}

/** Installs the entry into `project` and certifies it, each in the sandbox. */
function certify(entry: ManifestEntry, project: string, timeoutS: number): RunResult {
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'nymbal-registry-certify', private: true, type: 'module' }, null, 2)}\n`,
  )
  let spec: string
  if ('dir' in entry.source) {
    const dir = resolve(REPO, entry.source.dir)
    if (!existsSync(dir))
      return { kind: 'fail', line: `install failed: ${entry.source.dir} does not exist` }
    const pack = spawnSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', project, dir],
      { cwd: project, encoding: 'utf8', timeout: timeoutS * 1000, maxBuffer: OUTPUT_LIMIT },
    )
    let file: string | undefined
    try {
      file = (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]?.filename
    } catch {
      file = undefined
    }
    if (pack.status !== 0 || file === undefined) {
      return { kind: 'fail', line: `pack failed: ${npmErrorLine(`${pack.stdout}${pack.stderr}`)}` }
    }
    spec = join(project, file)
  } else {
    spec = `${entry.package}@${entry.source.npm}`
  }

  const install = sandbox(
    project,
    [
      'npm',
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(project, '.npm'),
      spec,
    ],
    { network: true, timeoutS },
  )
  if (install.timedOut) return { kind: 'fail', line: `timed out after ${timeoutS} s (install)` }
  if (install.status !== 0)
    return { kind: 'fail', line: `install failed: ${npmErrorLine(install.out)}` }

  // The suites and the vitest that runs them are the workspace's, as `nymbal test:contracts` finds them in a store.
  const vitest = dirname(createRequire(join(REPO, 'package.json')).resolve('vitest/package.json'))
  for (const [name, target] of [
    ['vitest', vitest],
    ['@nymbalhq/contract-tests', CONTRACT_TESTS],
  ] as const) {
    const at = join(project, 'node_modules', name)
    mkdirSync(dirname(at), { recursive: true })
    rmSync(at, { recursive: true, force: true })
    symlinkSync(target, at, 'dir')
  }

  const run = sandbox(project, ['node', CLI_BIN, 'test:contracts', '--package', entry.package], {
    network: false,
    timeoutS,
  })
  if (run.timedOut) return { kind: 'fail', line: `timed out after ${timeoutS} s (certify)` }
  const lines = run.out.split('\n').map((l) => l.trim())
  const passed =
    run.status === 0 ? lines.find((l) => l.startsWith(`certified ${entry.package} `)) : undefined
  const count = passed === undefined ? undefined : /: (\d+) cases passed$/.exec(passed)?.[1]
  if (count !== undefined) return { kind: 'pass', passed: Number(count) }
  const refused = lines.find((l) => l.startsWith(`not certified ${entry.package} `))
  if (refused !== undefined) return { kind: 'fail', line: refused }
  const line = lastLine(run.out)
  if (line.startsWith('no contract suite for kind ')) return { kind: 'no-suite', line }
  return {
    kind: 'fail',
    line: line === '' ? `test:contracts exited ${String(run.status)} with no result` : line,
  }
}

function readHistory(path: string): Record<string, EntryHistory> {
  if (!existsSync(path)) return {}
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new RunError(`${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RunError(`${path}: not an object of entries by package`)
  }
  return value as Record<string, EntryHistory>
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      manifest: { type: 'string' },
      history: { type: 'string' },
      out: { type: 'string' },
      now: { type: 'string' },
      'entry-timeout': { type: 'string', default: '600' },
      work: { type: 'string' },
    },
  })
  if (values.manifest === undefined || values.history === undefined || values.out === undefined) {
    throw new RunError(
      'usage: pnpm registry --manifest <file> --history <file> --out <dir> [--now <ISO>] [--entry-timeout <s>] [--work <dir>]',
    )
  }
  const now = values.now === undefined ? new Date() : new Date(values.now)
  if (Number.isNaN(now.getTime())) throw new RunError(`--now ${values.now}: not a date`)
  const timeoutS = Number(values['entry-timeout'])
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) {
    throw new RunError(`--entry-timeout ${values['entry-timeout']}: not a whole number of seconds`)
  }

  let value: unknown
  try {
    value = JSON.parse(readFileSync(values.manifest, 'utf8'))
  } catch (err) {
    throw new RunError(`${values.manifest}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const problems = validateManifest(value, REPO)
  if (problems.length > 0) throw new RunError(problems.join('\n'))
  const manifest = value as Manifest
  if (!existsSync(CLI_DIST)) {
    throw new RunError(`the workspace CLI is not built (${CLI_DIST} is missing): run pnpm build`)
  }
  const previous = readHistory(values.history)
  // Pulled once up front, and only when an entry will run in it: a registry that cannot reach the image is the run's
  // failure, not every adapter's, and a night with nothing to certify does not need it.
  if (manifest.adapters.some((e) => e.tier !== 'first-party')) {
    const pull = spawnSync('docker', ['pull', IMAGE], { encoding: 'utf8', maxBuffer: OUTPUT_LIMIT })
    if (pull.status !== 0) {
      throw new RunError(
        `docker pull ${IMAGE}: ${lastLine(`${pull.stderr ?? ''}${pull.error?.message ?? ''}`)}`,
      )
    }
  }

  const work = values.work === undefined ? undefined : resolve(values.work)
  const history: Record<string, EntryHistory> = {}
  for (const entry of manifest.adapters) {
    if (entry.tier === 'first-party') {
      history[entry.package] = {
        status: 'first-party',
        failingSince: null,
        lastRun: now.toISOString(),
        line: '',
      }
      continue
    }
    const slug = badgePath(entry.package).slice('badges/'.length, -'.svg'.length)
    const project = mkdtempSync(join(work ?? tmpdir(), `${slug}-`))
    try {
      history[entry.package] = nextStatus(
        previous[entry.package],
        certify(entry, project, timeoutS),
        now,
      )
    } finally {
      if (work === undefined) rmSync(project, { recursive: true, force: true })
    }
    process.stdout.write(`${entry.package}: ${history[entry.package]!.status}\n`)
  }

  const out = resolve(values.out)
  mkdirSync(join(out, 'badges'), { recursive: true })
  for (const entry of manifest.adapters) {
    writeFileSync(
      join(out, badgePath(entry.package)),
      renderBadge(entry.package, history[entry.package]!.status),
    )
  }
  writeFileSync(join(out, 'index.html'), renderStatusPage(manifest, history, now))
  writeFileSync(
    join(out, 'status.json'),
    `${JSON.stringify(
      {
        generatedAt: now.toISOString(),
        adapters: manifest.adapters.map((e) => ({ ...e, history: history[e.package] })),
      },
      null,
      2,
    )}\n`,
  )
  mkdirSync(dirname(resolve(values.history)), { recursive: true })
  writeFileSync(values.history, `${JSON.stringify(history, null, 2)}\n`)
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  if (!(err instanceof RunError)) throw err
  process.stderr.write(`${err.message}\n`)
  process.exitCode = 1
}
