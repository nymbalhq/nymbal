import { randomBytes, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpListener, type IncomingMessage, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import pg from 'pg'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import type { Logger, Role } from '@nymbalhq/types'
import { createHttpServer } from '../../../http/src/index.js'
import { createApp, type NymbalApp } from '../../src/app.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'
import { MIGRATIONS_ROOT, type Dialect } from './kernel.js'
import { bytesOf, flipByte } from './bytes.js'
import { shopper, type ShopResponse } from './shopper.js'

export { bytesOf, flipByte }

// A store booted through createApp on a database the caller owns, served over HTTP with the logger the app hands its
// platform (as `nymbal dev` serves it), so a test can stop it and boot it again on the same rows; stub Stripe and
// Anthropic APIs that record the credential of every call; a log capture that keeps every record as written and
// parsed; and the settings rows read and written through a second connection. Nothing here knows how settings are
// stored beyond the table and column names.

const HOST = '127.0.0.1'

export const SECRETS_KEY = 'NYMBAL_SECRETS_KEY'
export const SECRETS_KEY_OLD = 'NYMBAL_SECRETS_KEY_OLD'

const SECRET_CHARS = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-',
  ...'&?#%<>"{}|\\^~[]`\';:@!$*(),',
]

/**
 * AC-4's secret values: 16-64 characters from base64's alphabet and URL-unsafe punctuation (no space or control
 * character, which an HTTP header would not carry intact), with at least 8 distinct characters so a match in output
 * is the value and not a run of one character.
 */
export const secretArb = fc
  .string({ unit: fc.constantFrom(...SECRET_CHARS), minLength: 16, maxLength: 64 })
  .filter((s) => new Set(s).size >= 8)

/** A fresh master key: 32 random bytes, base64. */
export function newSecretsKey(): string {
  return randomBytes(32).toString('base64')
}

/** The 32 key bytes a base64 `NYMBAL_SECRETS_KEY` holds. */
export function keyBytes(base64: string): Buffer {
  return Buffer.from(base64, 'base64')
}

/** Sets (or, for `undefined`, removes) each variable in this process; the returned function puts every one back. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** Cleanups run last-in first-out, each one even when an earlier one throws. */
export function cleanups() {
  const pending: Array<() => unknown> = []
  return {
    add(fn: () => unknown): void {
      pending.push(fn)
    },
    async run(): Promise<void> {
      const errors: unknown[] = []
      while (pending.length > 0) {
        try {
          await pending.pop()!()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw errors[0]
    },
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

// ─── Config ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const NATIVE_COMMERCE = {
  payments: { provider: 'native' },
  email: { provider: 'native', config: { transport: 'console' } },
  reviews: { provider: 'native' },
  search: { provider: 'native' },
  analytics: { provider: 'native' },
  shipping: { provider: 'native' },
  tax: { provider: 'native' },
  ai: { provider: 'none' },
}

/**
 * The raw config of a settings test store (before the schema parses it), with `commerce` overriding the native slots:
 * what a test writes into a project's nymbal.config.ts and what the in-process store parses, so both see one store.
 */
export function settingsConfigInput(
  dialect: Dialect,
  commerce: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: dialect,
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: {
      adapter: 'middleware',
      botProtection: { mode: 'off' },
      rateLimit: {
        '/api/auth/login': { requests: 1000, window: '1m', action: 'block' },
        '/api/auth/register': { requests: 1000, window: '1m', action: 'block' },
      },
    },
    commerce: { ...NATIVE_COMMERCE, ...commerce },
    http: { adapter: 'fastify', port: 3999, host: HOST },
    deployment: { strategy: 'standard' },
  }
}

export function settingsConfig(
  dialect: Dialect,
  commerce: Record<string, unknown> = {},
): NymbalConfig {
  return nymbalConfigSchema.parse(settingsConfigInput(dialect, commerce))
}

/** A Stripe payments block pointed at `stub` (the adapter's host, port and protocol seam), with `extra` beside it. */
export function stripeBlock(stub: Stub, extra: Record<string, unknown> = {}) {
  return {
    provider: 'stripe',
    config: { host: HOST, port: stub.port, protocol: 'http', ...extra },
  }
}

/** An Anthropic ai block whose declared `baseUrl` is `stub`. */
export function anthropicBlock(stub: Stub, extra: Record<string, unknown> = {}) {
  return { provider: 'anthropic', config: { baseUrl: stub.url, ...extra } }
}

// ─── Stores ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A copy of the migrations folder for `dialect` holding only 0000-0007: a store from before the settings table. */
export function migrationsBefore0008(dialect: Dialect): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'settings-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 7)
  if (journal.entries.length !== 8) throw new Error(`expected migrations 0000-0007 in ${from}`)
  for (const entry of journal.entries) {
    cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
  }
  writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

const storage = (dialect: Dialect, target: string) =>
  dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }

export async function migrate(
  dialect: Dialect,
  target: string,
  migrationsRoot = MIGRATIONS_ROOT,
): Promise<void> {
  const store = createCommandStore(settingsConfig(dialect), storage(dialect, target))
  try {
    await runMigrations(store, { migrationsRoot })
  } finally {
    await store.close()
  }
}

export interface ApiClient {
  call<T>(method: string, path: string, body?: unknown): Promise<ShopResponse<T>>
}

export interface Store {
  app: NymbalApp
  baseUrl: string
  /** A fresh account holding `roles`, signed in over HTTP; every call carries its bearer token. */
  member(roles: Role[]): Promise<ApiClient>
  admin(): Promise<ApiClient>
  /** Stops the server, then the app; a second call does nothing. */
  stop(): Promise<void>
}

const quiet = (): Logger => createLogger({ pretty: false, level: 'error' })

/**
 * createApp on `target` (migrated first unless `migrate` is false), served over HTTP with `app.platform.logger`, the
 * logger `nymbal dev` gives its HTTP server. It reads the master key and adapter env from `process.env` as it is when
 * called. Rejects as createApp rejects.
 */
export async function openStore(opts: {
  dialect: Dialect
  target: string
  config: NymbalConfig
  logger?: Logger
  migrate?: boolean
  migrationsRoot?: string
}): Promise<Store> {
  if (opts.migrate !== false) await migrate(opts.dialect, opts.target, opts.migrationsRoot)
  const app = await createApp(opts.config, {
    ...storage(opts.dialect, opts.target),
    logger: opts.logger ?? quiet(),
  })
  for (let attempt = 0; ; attempt += 1) {
    const port = await freePort()
    const http = createHttpServer({
      config: { ...opts.config, http: { ...opts.config.http, port, host: HOST } },
      logger: app.platform.logger,
      documentStore: app.platform.documentStore,
      version: '0.0.0',
    })
    try {
      await app.attachHttp(http.adapter)
      await http.start()
    } catch (error) {
      if (attempt > 0 || (error as NodeJS.ErrnoException | null)?.code !== 'EADDRINUSE') {
        await app.stop()
        throw error
      }
      continue
    }
    const baseUrl = `http://${HOST}:${port}`
    const member = async (roles: Role[]): Promise<ApiClient> => {
      const email = `settings-${randomUUID()}@settings.test`
      const password = 'correct-horse-battery'
      const now = new Date()
      await app.platform.commandStore.transaction((tx) =>
        app.repos.customer.insert(tx, {
          id: randomUUID(),
          email,
          passwordHash: bcrypt.hashSync(password, 4),
          roles,
          requiresPasswordReset: false,
          createdAt: now,
          updatedAt: now,
        }),
      )
      // One safe request primes the CSRF cookie the shopper then echoes on every unsafe one.
      const shop = shopper(baseUrl)
      await shop.call('GET', '/health')
      const answer = await shop.call<{ accessToken: string }>('POST', '/api/auth/login', {
        email,
        password,
      })
      if (answer.status !== 200) throw new Error(`login: ${JSON.stringify(answer.body)}`)
      const token = answer.body.data!.accessToken
      return {
        call: (method, path, body) =>
          shop.call(method, path, body, { headers: { authorization: `Bearer ${token}` } }),
      }
    }
    let stopped = false
    return {
      app,
      baseUrl,
      member,
      admin: () => member(['admin']),
      async stop() {
        if (stopped) return
        stopped = true
        try {
          await http.stop()
        } finally {
          await app.stop()
        }
      },
    }
  }
}

/** The outcome of `openStore`: the store, or what it rejected with. */
export async function attemptStore(
  opts: Parameters<typeof openStore>[0],
): Promise<{ store: Store; error?: undefined } | { store?: undefined; error: unknown }> {
  try {
    return { store: await openStore(opts) }
  } catch (error) {
    return { error }
  }
}

// ─── The settings API ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SettingsFieldView {
  path: string
  label: string
  secret: boolean
  state: 'unset' | 'set'
  source: 'config' | 'env' | 'settings' | null
  updatedAt: string | null
  value?: unknown
}

/**
 * The `{ slot, path }` field of a `GET /api/admin/settings` body (each slot's provider and its declared fields).
 * Found by walking the body for a slot entry carrying `fields`, so the test does not pin how the slots are enclosed
 * (an array of `{ slot, fields }` or an object keyed by slot).
 */
export function settingsField(
  body: unknown,
  slot: string,
  path: string,
): SettingsFieldView | undefined {
  const seen = new Set<unknown>()
  const visit = (node: unknown, slotHint: string | undefined): SettingsFieldView | undefined => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return undefined
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, slotHint)
        if (found !== undefined) return found
      }
      return undefined
    }
    const record = node as Record<string, unknown>
    const at = typeof record['slot'] === 'string' ? record['slot'] : slotHint
    if (Array.isArray(record['fields'])) {
      if (at !== slot) return undefined
      return (record['fields'] as SettingsFieldView[]).find((f) => f?.path === path)
    }
    for (const [key, value] of Object.entries(record)) {
      const found = visit(value, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  return visit(body, undefined)
}

/** `PUT /api/admin/settings/:slot/:path` with `{ value }`. */
export function putSetting(client: ApiClient, slot: string, path: string, value: unknown) {
  return client.call<{ restartRequired?: boolean }>(
    'PUT',
    `/api/admin/settings/${encodeURIComponent(slot)}/${encodeURIComponent(path)}`,
    { value },
  )
}

/** A PUT that must succeed: throws with the answer otherwise, so a setup step never passes silently. */
export async function saveSetting(
  client: ApiClient,
  slot: string,
  path: string,
  value: string,
): Promise<void> {
  const res = await putSetting(client, slot, path, value)
  if (res.status !== 200) {
    throw new Error(
      `PUT /api/admin/settings/${slot}/${path}: ${res.status} ${JSON.stringify(res.body)}`,
    )
  }
}

/** Boots a store on `target`, saves each `[slot, path, value]` through the admin API, and stops it. */
export async function saveSettings(
  opts: Parameters<typeof openStore>[0],
  values: ReadonlyArray<readonly [string, string, string]>,
): Promise<void> {
  const store = await openStore(opts)
  try {
    const admin = await store.admin()
    for (const [slot, path, value] of values) await saveSetting(admin, slot, path, value)
  } finally {
    await store.stop()
  }
}

// ─── Rows, through a second connection ──────────────────────────────────────────────────────────────────────────────

export interface StoredSetting {
  slot: string
  path: string
  ciphertext: unknown
  plain: string | null
  iv: unknown
  tag: unknown
  key_id: string | null
}

/**
 * A second connection to the store's database (the shape of raw.ts's reader, kept apart so the CLI project can type
 * this file without the platform's support): a fresh read-only SQLite connection per query, or a small Postgres pool.
 */
export interface RowReader {
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

export function openReader(dialect: Dialect, target: string): RowReader {
  const pool =
    dialect === 'postgres' ? new pg.Pool({ connectionString: target, max: 2 }) : undefined
  return {
    async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (pool !== undefined) {
        let n = 0
        const result = await pool.query(
          sql.replace(/\?/g, () => `$${(n += 1)}`),
          params,
        )
        return result.rows as T[]
      }
      const db = new Database(target, { readonly: true, fileMustExist: true })
      try {
        return db.prepare(sql).all(...params) as T[]
      } finally {
        db.close()
      }
    },
    async close() {
      await pool?.end()
    },
  }
}

export function storedSettings(raw: RowReader): Promise<StoredSetting[]> {
  return raw.rows<StoredSetting>(
    'SELECT slot, path, ciphertext, plain, iv, tag, key_id FROM settings ORDER BY slot, path',
  )
}

/** One write statement on its own connection (`?` placeholders, renumbered for Postgres). */
export async function execSql(
  dialect: Dialect,
  target: string,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  if (dialect === 'sqlite') {
    const db = new Database(target, { fileMustExist: true })
    try {
      db.prepare(sql).run(...params)
    } finally {
      db.close()
    }
    return
  }
  let n = 0
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    await client.query(
      sql.replace(/\?/g, () => `$${(n += 1)}`),
      params,
    )
  } finally {
    await client.end()
  }
}

/** Flips one byte of the stored ciphertext of `slot`/`path`, as an attacker with database access would. */
export async function tamperCiphertext(
  dialect: Dialect,
  raw: RowReader,
  target: string,
  slot: string,
  path: string,
): Promise<void> {
  const row = (await storedSettings(raw)).find((r) => r.slot === slot && r.path === path)
  if (row === undefined || row.ciphertext === null) {
    throw new Error(`no encrypted settings row for ${slot}.${path}`)
  }
  await execSql(dialect, target, 'UPDATE settings SET ciphertext = ? WHERE slot = ? AND path = ?', [
    flipByte(row.ciphertext),
    slot,
    path,
  ])
}

// ─── Stub provider APIs ─────────────────────────────────────────────────────────────────────────────────────────────

export interface StubCall {
  method: string
  path: string
  /** The credential the call carried: Stripe's bearer token, Anthropic's `x-api-key`. */
  credential: string | undefined
}

export interface Stub {
  url: string
  port: number
  calls: StubCall[]
  credentials(): Array<string | undefined>
  /** Which credentials it answers; every one by default, else 401. */
  accept: (credential: string | undefined) => boolean
  reset(): void
  close(): Promise<void>
}

export const STUB_SUGGESTION = 'A stub suggestion from the Anthropic stand-in'

async function drain(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * A stand-in for the provider's API on a free port: Stripe answers `GET /v1/balance` (the adapter's health check),
 * Anthropic answers `POST /v1/messages` with one text block. Every call is recorded with its credential.
 */
export async function startStub(kind: 'stripe' | 'anthropic'): Promise<Stub> {
  const calls: StubCall[] = []
  const stub: Stub = {
    url: '',
    port: 0,
    calls,
    credentials: () => calls.map((c) => c.credential),
    accept: () => true,
    reset: () => {
      calls.length = 0
    },
    close: async () => undefined,
  }
  const server: Server = createHttpListener((req, res) => {
    void (async () => {
      await drain(req)
      const path = (req.url ?? '').split('?')[0] ?? ''
      const header =
        kind === 'stripe'
          ? req.headers.authorization
          : (req.headers['x-api-key'] as string | undefined)
      const credential =
        kind === 'stripe' && header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : header
      calls.push({ method: req.method ?? 'GET', path, credential })
      const send = (status: number, body: unknown) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'stripe-should-retry': 'false',
        })
        res.end(JSON.stringify(body))
      }
      if (!stub.accept(credential)) {
        return kind === 'stripe'
          ? send(401, {
              error: { type: 'invalid_request_error', message: 'Invalid API Key provided' },
            })
          : send(401, {
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid x-api-key' },
            })
      }
      if (kind === 'stripe' && path === '/v1/balance') {
        return send(200, { object: 'balance', available: [], pending: [], livemode: false })
      }
      if (kind === 'anthropic' && req.method === 'POST' && path.endsWith('/v1/messages')) {
        return send(200, {
          id: `msg_${randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: STUB_SUGGESTION }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }
      return send(404, { error: { type: 'invalid_request_error', message: `no stub for ${path}` } })
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve))
  const { port } = server.address() as { port: number }
  stub.port = port
  stub.url = `http://${HOST}:${port}`
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return stub
}

// ─── Logs ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LogRecord {
  level: string
  obj: unknown
  msg: string | undefined
  bindings: Record<string, unknown>
}

export interface LogCapture {
  /** A caller's own Logger: records every call as made, and writes it on to a pino logger with a destination. */
  logger: Logger
  /** Every call the caller's logger received, unserialised. */
  calls: LogRecord[]
  /** Every record the pino logger (`createLogger({ destination })`) wrote, parsed. */
  written(): unknown[]
  /** Every string in both: values and keys, deeply, Errors' own properties included. */
  strings(): string[]
}

/**
 * Both log capture paths at once: the logger handed to createApp is a caller's own (not pino), whose calls are kept
 * as objects, and it writes each call on to `createLogger({ destination })`, whose JSON lines are kept and parsed
 * (JSON escaping hides a raw match).
 */
export function captureLogs(): LogCapture {
  const lines: string[] = []
  const destination = { write: (line: string) => void lines.push(line) }
  const pino = createLogger({ pretty: false, level: 'trace', destination })
  const calls: LogRecord[] = []
  const recording = (target: Logger, bindings: Record<string, unknown>): Logger => {
    const at =
      (level: 'trace' | 'debug' | 'info' | 'warn' | 'error') => (obj: unknown, msg?: string) => {
        calls.push({ level, obj, msg, bindings })
        target[level](obj, msg)
      }
    return {
      trace: at('trace'),
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: (more) => recording(target.child(more), { ...bindings, ...more }),
    }
  }
  const written = (): unknown[] =>
    lines
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as unknown)
  return {
    logger: recording(pino, {}),
    calls,
    written,
    strings: () => stringsIn([...written(), ...calls]),
  }
}

/** Every string reachable from `values`: object keys and values, Error own properties, buffers as UTF-8. */
export function stringsIn(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new WeakSet<object>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 16) return
    if (typeof value === 'string') return void out.push(value)
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return
    if (typeof value !== 'object' || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return void out.push(Buffer.from(value).toString('utf8'))
    }
    if (value instanceof Map) {
      for (const [k, v] of value) {
        visit(k, depth + 1)
        visit(v, depth + 1)
      }
      return
    }
    if (value instanceof Set) {
      for (const v of value) visit(v, depth + 1)
      return
    }
    const keys =
      value instanceof Error
        ? [...new Set([...Reflect.ownKeys(value), 'message', 'stack', 'cause'])]
        : Reflect.ownKeys(value)
    for (const key of keys) {
      if (typeof key === 'string') out.push(key)
      visit((value as Record<PropertyKey, unknown>)[key], depth + 1)
    }
  }
  for (const value of values) visit(value, 0)
  return out
}

/** The texts that carry `secret` or its base64 (standard or URL-safe), each cut to a window around the match. */
export function leaks(texts: readonly string[], secret: string): string[] {
  const needles = new Set([
    secret,
    Buffer.from(secret, 'utf8').toString('base64'),
    Buffer.from(secret, 'utf8').toString('base64url'),
  ])
  const found: string[] = []
  for (const text of texts) {
    for (const needle of needles) {
      const at = text.indexOf(needle)
      if (at >= 0) found.push(text.slice(Math.max(0, at - 60), at + needle.length + 60))
    }
  }
  return found
}
