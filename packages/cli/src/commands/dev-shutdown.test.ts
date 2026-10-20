import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { Agent, request, type IncomingMessage } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// P1-14 AC-2: `nymbal dev --api-only` exits promptly on a signal with the admin's live stream open. Kills: a shutdown
// that waits on the open stream (measured by the 2026-10-19 release QA: over 60 s), for SIGTERM or for SIGINT.
// Spawns the built CLI (`pnpm build` first), on a free port and a fresh SQLite file of its own.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const CLI_BIN = resolve(HERE, '..', '..', 'bin', 'nymbal.mjs')
const ADMIN_DIST = resolve(REPO_ROOT, 'apps', 'admin', 'dist')
const ADMIN_EMAIL = 'admin@nymbal.local'
const ADMIN_PASSWORD = 'nymbal-admin-dev'

const EXIT_WITHIN_MS = 3000
/** Migrate, seed and listen take about 3 s warm; past this the API is not coming up on the port it was given. */
const READY_WITHIN_MS = 30_000

let cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolvePort(port))
    })
  })
}

interface Api {
  child: ChildProcess
  port: number
  base: string
  output: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

async function startApi(): Promise<Api> {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-p1-14-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const child = spawn(process.execPath, [CLI_BIN, 'dev', '--api-only', '--port', String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db'),
      NYMBAL_ADMIN_DIST: ADMIN_DIST,
      NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    child.once('exit', (code, signal) => r({ code, signal })),
  )
  let gone = false
  void exited.then(() => (gone = true))
  cleanup.push(async () => {
    if (!gone) {
      child.kill('SIGKILL')
      await exited
    }
  })
  const api: Api = { child, port, base: `http://127.0.0.1:${port}`, output: () => out, exited }

  const deadline = Date.now() + READY_WITHIN_MS
  while (Date.now() < deadline && !gone) {
    const up = await fetch(`${api.base}/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (up) return api
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(
    `nymbal dev --api-only --port ${port} did not answer GET /health on :${port} within ${READY_WITHIN_MS} ms` +
      ` (${gone ? 'it exited' : 'still running'}). Output:\n${out.slice(-2000)}`,
  )
}

/** Signs in as the seeded admin and takes a single-use stream ticket, as the admin SPA does. */
async function adminTicket(base: string): Promise<string> {
  const jar = new Map<string, string>()
  const call = async (method: string, path: string, body?: unknown, auth?: string) => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const csrf = jar.get('nymbal.csrf')
    if (csrf !== undefined) headers['x-csrf-token'] = csrf
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth !== undefined) headers.authorization = `Bearer ${auth}`
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const at = pair!.indexOf('=')
      if (at > 0) jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim())
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`)
    return JSON.parse(text) as { data: Record<string, unknown> }
  }
  await call('GET', '/api/csrf')
  const login = await call('POST', '/api/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  })
  const token = login.data['accessToken'] as string
  const ticket = await call('POST', '/api/admin/events/ticket', {}, token)
  return ticket.data['ticket'] as string
}

/** Holds `/api/admin/events` open on a keep-alive socket until the server confirms with `event: connected`. */
async function holdAdminStream(base: string, ticket: string): Promise<IncomingMessage> {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  cleanup.push(() => agent.destroy())
  const url = new URL(`${base}/api/admin/events?ticket=${encodeURIComponent(ticket)}`)
  return new Promise<IncomingMessage>((resolveStream, reject) => {
    const timer = setTimeout(() => reject(new Error('no `event: connected` within 5000 ms')), 5000)
    const req = request(url, { agent, headers: { accept: 'text/event-stream' } }, (res) => {
      let seen = ''
      res.on('data', (b: Buffer) => {
        seen += b.toString()
        if (seen.includes('event: connected')) {
          clearTimeout(timer)
          resolveStream(res)
        }
      })
      res.on('error', () => {})
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}

/** Ms from the signal to the exit, or `Infinity` when the process is still alive `EXIT_WITHIN_MS + 2000` later. */
async function signalAndTime(
  api: Api,
  signal: NodeJS.Signals,
): Promise<{ ms: number; code: number | null }> {
  const sentAt = Date.now()
  api.child.kill(signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), EXIT_WITHIN_MS + 2000)
  })
  const exit = await Promise.race([api.exited, gaveUp])
  clearTimeout(timer)
  if (exit === null) return { ms: Number.POSITIVE_INFINITY, code: null }
  return { ms: Date.now() - sentAt, code: exit.code }
}

describe('P1-14 nymbal dev --api-only shutdown with the admin stream open', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(
      `AC-2: with an admin holding /api/admin/events open, ${signal} ends the process with code 0 within 3 s`,
      {
        timeout: READY_WITHIN_MS + 30_000,
      },
      async () => {
        const api = await startApi()
        const stream = await holdAdminStream(api.base, await adminTicket(api.base))
        expect(stream.statusCode).toBe(200)

        const { ms, code } = await signalAndTime(api, signal)
        expect(
          ms,
          `ms from ${signal} to exit; output tail:\n${api.output().slice(-1500)}`,
        ).toBeLessThan(EXIT_WITHIN_MS)
        expect(code, `exit code after ${signal}`).toBe(0)
      },
    )
  }
})
