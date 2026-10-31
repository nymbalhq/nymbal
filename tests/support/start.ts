import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NymbalConfig } from '@nymbalhq/config'
import { createCommandStore } from '../../packages/platform/src/db/command-store.js'
import { runMigrations } from '../../packages/platform/src/db/migrate.js'
import { CLI_BIN, cliEnv, freePort, MIGRATIONS_ROOT, stripAnsi } from './doctor.js'
import { install } from './project.js'

// What the `nymbal start` tests share. They spawn the built CLI (`pnpm build` first) in a store project of their own
// and reach it only through its port, its exit and its output; nothing here knows how `start` is built. The storefront
// is the stand-in at tests/fixtures/storefront/upstream.mjs, given through NYMBAL_STOREFRONT_ENTRY.

export type Dialect = 'sqlite' | 'postgres'

export const UPSTREAM_FIXTURE = fileURLToPath(
  new URL('../fixtures/storefront/upstream.mjs', import.meta.url),
)
export const NEXT_START_FIXTURE = fileURLToPath(
  new URL('../fixtures/storefront/next-start.mjs', import.meta.url),
)
export const ADMIN_DIST_FIXTURE = fileURLToPath(new URL('../fixtures/admin-dist', import.meta.url))
export const PUBLIC_URL = 'https://shop.example'
/** The bound `start` puts on its whole shutdown when NYMBAL_SHUTDOWN_MS is unset. */
export const DEFAULT_SHUTDOWN_MS = 10_000

const PLATFORM_DIR = fileURLToPath(new URL('../../packages/platform', import.meta.url))
const platformRequire = createRequire(
  fileURLToPath(new URL('../../packages/platform/package.json', import.meta.url)),
)

/** A fresh NYMBAL_SECRETS_KEY: 32 random bytes, base64. */
export function secretsKey(): string {
  return randomBytes(32).toString('base64')
}

/** A store's raw config: native commerce, `infrastructure` over SQLite, in-memory and in-process. */
export function storeConfig(
  infrastructure: Record<string, unknown> = {},
  template: 'astro' | 'nextjs' = 'astro',
): Record<string, unknown> {
  return {
    store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
      ...infrastructure,
    },
    security: { adapter: 'middleware', botProtection: { mode: 'off' } },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native', config: { transport: 'console' } },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify' },
    deployment: { strategy: 'standard' },
  }
}

export interface StoreProject {
  dir: string
  remove(): void
}

/**
 * A store project in the system temp directory: `config` as its nymbal.config.ts, a package.json, and the platform
 * (its migrations) plus `installed` in its node_modules.
 */
export function storeProject(
  config: Record<string, unknown>,
  installed: Record<string, string> = {},
): StoreProject {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-start-')))
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'shop', private: true, type: 'module' }, null, 2)}\n`,
  )
  install(dir, { '@nymbalhq/platform': PLATFORM_DIR, ...installed })
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * The environment `start` passes its check with, plus `extra` (a key set to `undefined` is removed). Staging, not
 * production: a production app refuses these stores' stub payments and default JWT secret while it is built.
 */
export function startEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return cliEnv({
    NODE_ENV: 'staging',
    NYMBAL_PUBLIC_URL: PUBLIC_URL,
    NYMBAL_SECRETS_KEY: secretsKey(),
    NYMBAL_ADMIN_DIST: ADMIN_DIST_FIXTURE,
    NYMBAL_SHUTDOWN_MS: undefined,
    PORT: undefined,
    ...extra,
  })
}

// ─── The storefront stand-in ────────────────────────────────────────────────────────────────────────────────────────

export interface UpstreamRequest {
  method: string
  path: string
}

export interface Upstream {
  /** The file to give as NYMBAL_STOREFRONT_ENTRY. */
  entry: string
  /** Every request the stand-in got, in order, across every start. */
  requests: UpstreamRequest[]
  /** How many times a stand-in has come up. */
  started(): number
  /** The pid of the next stand-in to come up (the first, until one has). */
  up(): Promise<number>
  /** The path of the next held request to arrive. */
  arrival(): Promise<string>
  /** Lets the oldest held request go on. */
  release(): void
  /** When the stand-in's connection closed (its process ended), as Date.now(). */
  gone(): Promise<number>
  close(): Promise<void>
}

/** A queue of values that resolves each waiter with the next value, whichever comes first. */
function queue<T>() {
  const values: T[] = []
  const waiters: Array<(value: T) => void> = []
  return {
    push(value: T) {
      const waiter = waiters.shift()
      if (waiter) waiter(value)
      else values.push(value)
    },
    next(): Promise<T> {
      if (values.length > 0) return Promise.resolve(values.shift()!)
      return new Promise<T>((resolve) => waiters.push(resolve))
    },
  }
}

/** The stand-in, copied into `dir` with a control port of this process's, so the test sees what it gets and holds. */
export async function upstream(dir: string): Promise<Upstream> {
  const ups = queue<number>()
  const arrivals = queue<string>()
  const goneAt = queue<number>()
  const requests: UpstreamRequest[] = []
  const sockets = new Set<Socket>()
  let current: Socket | null = null
  let count = 0
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    current = socket
    socket.setEncoding('utf8')
    let buffered = ''
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let at: number
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        const message = JSON.parse(line) as {
          event: string
          pid?: number
          path?: string
          method?: string
        }
        if (message.event === 'up') {
          count += 1
          ups.push(message.pid!)
        } else if (message.event === 'arrived') arrivals.push(message.path!)
        else if (message.event === 'request') {
          requests.push({ method: message.method!, path: message.path! })
        }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      goneAt.push(Date.now())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const entry = join(dir, 'storefront-upstream.mjs')
  copyFileSync(UPSTREAM_FIXTURE, entry)
  writeFileSync(join(dir, 'storefront-upstream.json'), JSON.stringify({ controlPort: port }))
  return {
    entry,
    requests,
    started: () => count,
    up: () => ups.next(),
    arrival: () => arrivals.next(),
    release: () => {
      current?.write('release\n')
    },
    gone: () => goneAt.next(),
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Whether a process is alive (signal 0 reaches it). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ─── The process ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Date.now() when it exited. */
  at: number
}

export interface StartRun {
  child: ChildProcess
  port: number
  base: string
  output(): string
  exited: Promise<Exit>
  /** Sends `signal` and returns Date.now() at the send. */
  signal(signal: NodeJS.Signals): number
  /**
   * Stops the run and whatever it started: SIGTERM, so `start` stops its storefront itself, then, past
   * KILL_GRACE_MS or once it has exited, SIGKILL to its process group, so no storefront outlives the test.
   */
  kill(): Promise<void>
}

const KILL_GRACE_MS = 5000

/** SIGKILL to every process left in the group `pid` leads; none left is fine. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Spawns `nymbal <args>` in `cwd` with PORT set to a free port (unless `env` sets one). */
export async function spawnStart(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<StartRun> {
  const port = opts.env['PORT'] !== undefined ? Number(opts.env['PORT']) : await freePort()
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    cwd: opts.cwd,
    env: { ...opts.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // A group of its own, so kill() reaches the storefront too.
    detached: true,
  })
  let out = ''
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  let done = false
  const exited = new Promise<Exit>((resolve) =>
    child.once('exit', (code, signal) => {
      done = true
      resolve({ code, signal, at: Date.now() })
    }),
  )
  return {
    child,
    port,
    base: `http://127.0.0.1:${port}`,
    output: () => stripAnsi(out),
    exited,
    signal(signal) {
      const at = Date.now()
      child.kill(signal)
      return at
    },
    async kill() {
      if (!done) {
        child.kill('SIGTERM')
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          exited,
          new Promise<void>((resolve) => (timer = setTimeout(resolve, KILL_GRACE_MS))),
        ])
        clearTimeout(timer)
      }
      killGroup(child.pid!)
      await exited
    },
  }
}

/** Resolves once GET /health on the run's port answers 200; throws with the run's output when it exits or times out. */
export async function untilServing(run: StartRun, withinMs = 60_000): Promise<void> {
  let gone = false
  void run.exited.then(() => (gone = true))
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline && !gone) {
    const up = await fetch(`${run.base}/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.status === 200)
      .catch(() => false)
    if (up) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(
    `nymbal start on :${run.port} did not answer GET /health within ${withinMs} ms` +
      ` (${gone ? 'it exited' : 'still running'}). Output:\n${run.output().slice(-3000)}`,
  )
}

export interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
  /** Date.now() when the response ended. */
  at: number
}

/** One request on a connection of its own (no keep-alive pool); rejects when the response is cut. */
export function send(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: opts.method ?? 'GET', headers: opts.headers ?? {}, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            at: Date.now(),
          }),
        )
        res.on('close', () => {
          if (!res.complete) reject(new Error(`${url}: response cut`))
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

/** GET /ready's status and JSON body. */
export async function readiness(
  base: string,
  timeoutMs = 15_000,
): Promise<{ status: number; body: { status?: string; failing?: string[] }; text: string }> {
  const res = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let body: { status?: string; failing?: string[] } = {}
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    body = {}
  }
  return { status: res.status, body, text }
}

// ─── Migrations ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The platform's migrations journal for `dialect`: how many entries `nymbal migrate` applies to an empty store. */
export function journalLength(dialect: Dialect): number {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_ROOT, dialect, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] }
  return journal.entries.length
}

const storage = (dialect: Dialect, target: string) =>
  dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }

/** Applies all but the newest `leave` migrations to the store at `target`, so `leave` are pending. */
export async function migrateAllBut(
  dialect: Dialect,
  target: string,
  leave: number,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'start-migrations-'))
  try {
    const from = join(MIGRATIONS_ROOT, dialect)
    const to = join(root, dialect)
    mkdirSync(join(to, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    journal.entries = journal.entries.slice(0, journal.entries.length - leave)
    for (const entry of journal.entries) {
      cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
    }
    writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
    const store = createCommandStore(
      { infrastructure: { commandStore: dialect } } as unknown as NymbalConfig,
      storage(dialect, target),
    )
    try {
      await runMigrations(store, { migrationsRoot: root })
    } finally {
      await store.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The rows in the store's migrations table, read on a connection of the test's own. */
export async function migrationRows(dialect: Dialect, target: string): Promise<number> {
  if (dialect === 'sqlite') {
    const Database = platformRequire('better-sqlite3') as new (
      path: string,
      opts: { readonly: boolean; fileMustExist: boolean },
    ) => { prepare(sql: string): { get(): { n: number } }; close(): void }
    const db = new Database(target, { readonly: true, fileMustExist: true })
    try {
      return db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get().n
    } finally {
      db.close()
    }
  }
  const pg = platformRequire('pg') as {
    Client: new (opts: { connectionString: string }) => {
      connect(): Promise<void>
      query(sql: string): Promise<{ rows: Array<{ n: number }> }>
      end(): Promise<void>
    }
  }
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    )
    return rows[0]!.n
  } finally {
    await client.end()
  }
}

export interface MigrationGate {
  journal: number
  /** Rows before the first start, with two migrations left pending. */
  rowsPending: number
  refused: { code: number | null; out: string; rows: number; storefrontStarted: number }
  migrated: { ready: number; rows: number; exit: number | null }
  restarted: { ready: number; rows: number; exit: number | null }
  migrateAgain: { code: number | null; out: string; rows: number }
}

/**
 * The migration gate, observed: two migrations pending, then `start`, `start --migrate`, `start` and `migrate`, each
 * in the project, with the store's migration rows read after each.
 */
export async function observeMigrationGate(
  dialect: Dialect,
  target: string,
  project: StoreProject,
  storeEnv: Record<string, string>,
): Promise<MigrationGate> {
  await migrateAllBut(dialect, target, 2)
  const rowsPending = await migrationRows(dialect, target)
  const stand = await upstream(project.dir)
  try {
    const env = startEnv({ ...storeEnv, NYMBAL_STOREFRONT_ENTRY: stand.entry })

    const first = await spawnStart(['start'], { cwd: project.dir, env })
    const exit = await Promise.race([
      first.exited,
      new Promise<Exit>((r) => setTimeout(() => r({ code: null, signal: null, at: 0 }), 30_000)),
    ])
    await first.kill()
    const refused = {
      code: exit.code,
      out: first.output(),
      rows: await migrationRows(dialect, target),
      storefrontStarted: stand.started(),
    }

    const serve = async (args: string[]) => {
      const run = await spawnStart(args, { cwd: project.dir, env })
      try {
        await untilServing(run)
        const ready = (await readiness(run.base)).status
        const rows = await migrationRows(dialect, target)
        run.signal('SIGTERM')
        const stopped = await Promise.race([
          run.exited,
          new Promise<Exit>((r) =>
            setTimeout(() => r({ code: null, signal: null, at: 0 }), 20_000),
          ),
        ])
        return { ready, rows, exit: stopped.code }
      } finally {
        await run.kill()
      }
    }
    const migrated = await serve(['start', '--migrate'])
    const restarted = await serve(['start'])

    const again = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI_BIN, 'migrate'], {
        cwd: project.dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', (b: Buffer) => (out += b.toString()))
      child.stderr.on('data', (b: Buffer) => (out += b.toString()))
      child.once('exit', (code) => resolve({ code, out: stripAnsi(out) }))
    })
    return {
      journal: journalLength(dialect),
      rowsPending,
      refused,
      migrated,
      restarted,
      migrateAgain: { ...again, rows: await migrationRows(dialect, target) },
    }
  } finally {
    await stand.close()
  }
}
