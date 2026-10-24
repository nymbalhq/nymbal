import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { KNOWN_PROVIDERS, nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { PROVIDER_PACKAGES } from '../../packages/platform/src/adapters/loader.js'
import { createCommandStore } from '../../packages/platform/src/db/command-store.js'
import { runMigrations } from '../../packages/platform/src/db/migrate.js'

// What the doctor and dev tests share. They spawn the built CLI (`pnpm build` first) and read its output: doctor's one
// line per check (`<ok|warn|down>  <name>  <detail>`) and its `--json` form, and dev's startup output. Nothing here
// knows how doctor or the summary is implemented.

const exec = promisify(execFile)

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const CLI_BIN = fileURLToPath(new URL('../../packages/cli/bin/nymbal.mjs', import.meta.url))
export const MIGRATIONS_ROOT = fileURLToPath(
  new URL('../../packages/platform/migrations', import.meta.url),
)
export const CUSTOM_FIXTURE_DIR = fileURLToPath(
  new URL('../e2e/fixtures/custom-providers', import.meta.url),
)

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolvePort(port))
    })
  })
}

/** A port nothing listens on: free a moment ago, and never bound by the test. */
export const closedPort = freePort

/**
 * The child's environment: this process's, without Vitest's variables, without a log level or any store selection
 * the shell may carry, plus `extra`. A key set to `undefined` in `extra` is removed.
 */
export function cliEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  for (const key of [
    'LOG_LEVEL',
    'NYMBAL_COMMAND_STORE',
    'NYMBAL_DOCUMENT_STORE',
    'NYMBAL_EVENT_BUS',
    'NYMBAL_REDIS_PREFIX',
    'NYMBAL_SQLITE_PATH',
    'DATABASE_URL',
    'REDIS_URL',
  ]) {
    delete env[key]
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

export interface CliRun {
  code: number
  stdout: string
  stderr: string
  /** stdout then stderr, ANSI codes removed. */
  out: string
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** Runs the built CLI to completion; a non-zero exit is a result, not a throw. */
export async function runCli(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; bin?: string },
): Promise<CliRun> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [opts.bin ?? CLI_BIN, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr, out: stripAnsi(stdout + stderr) }
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
    const stdout = e.stdout ?? ''
    const stderr = `${e.stderr ?? ''}${typeof e.code === 'number' ? '' : e.message}`
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      stdout,
      stderr,
      out: stripAnsi(stdout + stderr),
    }
  }
}

export type LineStatus = 'ok' | 'warn' | 'down'

export interface DoctorLine {
  status: LineStatus
  name: string
  detail: string
}

/**
 * Doctor's check lines: `<ok|warn|down>  <name>  <detail>`, columns two or more spaces apart, so a name may hold
 * single spaces (`command store`, `slot search`). Anything else in the output (a heading, a summary) is ignored.
 */
export function doctorLines(out: string): DoctorLine[] {
  const lines: DoctorLine[] = []
  for (const raw of stripAnsi(out).split('\n')) {
    const m = /^\s*(ok|warn|down) {2,}(\S+(?: \S+)*)(?: {2,}(.*))?\s*$/.exec(raw)
    if (m !== null) lines.push({ status: m[1] as LineStatus, name: m[2]!, detail: m[3] ?? '' })
  }
  return lines
}

export interface DoctorJsonCheck {
  name: string
  status: 'ok' | 'degraded' | 'down'
  detail: string
}

export function doctorJson(stdout: string): { checks: DoctorJsonCheck[] } {
  try {
    return JSON.parse(stdout) as { checks: DoctorJsonCheck[] }
  } catch {
    throw new Error(
      `doctor --json did not print one JSON document on stdout:\n${stdout.slice(0, 2000)}`,
    )
  }
}

/** The text status a `--json` status prints as (`degraded` is `warn`). */
export const TEXT_STATUS: Record<DoctorJsonCheck['status'], LineStatus> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'down',
}

export const PRIMITIVES = ['documentStore', 'eventBus', 'media'] as const

/** The check order: config, packages, command store, migrations, slots, primitives. */
export function categoryOf(name: string): number {
  if (name === 'config') return 0
  if (name.startsWith('package ')) return 1
  if (name === 'command store') return 2
  if (name === 'migrations') return 3
  if (name.startsWith('slot ')) return 4
  if (name.startsWith('primitive ')) return 5
  return 99
}

/** The commerce slots (KNOWN_PROVIDERS' keys; `commerce.orders` is settings, not a slot) with their providers. */
export function commerceSlots(config: NymbalConfig): Array<{ slot: string; provider: string }> {
  const commerce = config.commerce as unknown as Record<string, { provider: string }>
  return Object.keys(KNOWN_PROVIDERS).map((slot) => ({ slot, provider: commerce[slot]!.provider }))
}

/**
 * The check names a config gives, as a sorted set: `config`, `package <slot>` for every slot or primitive whose
 * provider has a package (PROVIDER_PACKAGES), `command store`, `migrations`, `slot <name>` per commerce slot,
 * `slot security` (with `package security` when `security.adapter` has a package) and `primitive <name>` per
 * primitive.
 */
export function expectedCheckNames(config: NymbalConfig): string[] {
  const names = ['config', 'command store', 'migrations']
  for (const { slot, provider } of commerceSlots(config)) {
    names.push(`slot ${slot}`)
    if (
      (PROVIDER_PACKAGES as Record<string, Record<string, unknown> | undefined>)[slot]?.[provider]
    ) {
      names.push(`package ${slot}`)
    }
  }
  names.push('slot security')
  if (PROVIDER_PACKAGES.security[config.security.adapter] !== undefined) {
    names.push('package security')
  }
  const infra = config.infrastructure as unknown as Record<string, string | undefined>
  for (const primitive of PRIMITIVES) {
    names.push(`primitive ${primitive}`)
    const provider = infra[primitive] ?? (primitive === 'media' ? 'local-fs' : undefined)
    if (provider !== undefined && PROVIDER_PACKAGES[primitive]?.[provider] !== undefined) {
      names.push(`package ${primitive}`)
    }
  }
  return names.sort()
}

/** A migrated SQLite command store at `path`, made with the platform's own migrations. */
export async function migratedSqlite(path: string): Promise<void> {
  const store = createCommandStore(
    { infrastructure: { commandStore: 'sqlite' } } as unknown as NymbalConfig,
    { sqlitePath: path },
  )
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await store.close()
  }
}

export interface DevRun {
  child: ChildProcess
  base: string
  port: number
  output: () => string
  stop: () => Promise<void>
}

/** `nymbal dev --api-only` on a free port, resolved once GET /health answers 200. */
export async function startDev(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; bin?: string; readyWithinMs?: number },
): Promise<DevRun> {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    [opts.bin ?? CLI_BIN, 'dev', '--api-only', '--port', String(port), ...args],
    { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  let gone = false
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  void exited.then(() => (gone = true))
  const stop = async () => {
    if (gone) return
    child.kill('SIGKILL')
    await exited
  }
  const base = `http://127.0.0.1:${port}`
  const within = opts.readyWithinMs ?? 60_000
  const deadline = Date.now() + within
  while (Date.now() < deadline && !gone) {
    const up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (up) return { child, base, port, output: () => stripAnsi(out), stop }
    await new Promise((r) => setTimeout(r, 200))
  }
  await stop()
  throw new Error(
    `nymbal dev --api-only ${args.join(' ')} did not answer GET /health on :${port} within ${within} ms` +
      ` (${gone ? 'it exited' : 'still running'}). Output:\n${stripAnsi(out).slice(-3000)}`,
  )
}

/** A pino debug entry, pretty (`DEBUG`) or JSON (`"level":20`). */
export const DEBUG_LINE = /\bDEBUG\b|"level"\s*:\s*20\b/

const BOUNDARY = '[\\s:,()\\[\\]|=]'

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Does `line` hold `token` as a whole word (bounded by space or punctuation, not by other name characters)? */
export function hasToken(line: string, token: string): boolean {
  return new RegExp(`(^|${BOUNDARY})${escapeRe(token)}($|${BOUNDARY})`).test(line)
}

/** The lines of `out` that name both `a` and `b` as whole words. */
export function linesNaming(out: string, a: string, b: string): string[] {
  return stripAnsi(out)
    .split('\n')
    .filter((line) => hasToken(line, a) && hasToken(line, b))
}

/**
 * A config module's export parsed on the default store set (SQLite, in-memory, in-process), whatever store
 * variables the shell running the tests carries: cliEnv removes them from every child.
 */
export function onDefaultStores(raw: { infrastructure: object }): NymbalConfig {
  return nymbalConfigSchema.parse({
    ...raw,
    infrastructure: {
      ...raw.infrastructure,
      commandStore: 'sqlite',
      documentStore: 'in-memory',
      eventBus: 'in-process',
    },
  })
}
