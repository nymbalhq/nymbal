import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { decodeJwt } from 'jose'
import { expect, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import type { EmailAdapter, TransactionalEmail } from '@nymbalhq/types'
import { createLogger } from '../../src/logger.js'
import { serveKernel, type ServedKernel } from './http.js'
import type { Kernel } from './kernel.js'
import { eventRows } from './outbox.js'
import { openRaw, type RawReader } from './raw.js'
import { primedShopper } from './security.js'

// A store for the password journeys: a kernel served over HTTP whose email slot is a capturing adapter of the tests'
// own (`custom`, so the store delivers), with the store's URL set, every log line kept, and the password routes'
// per-address limits raised so a suite can call them many times from 127.0.0.1 (the built-in bounds are proven in the
// http package). Mail is read from the adapter the handler calls, rows from a second connection.

export const STORE_URL = 'https://shop.test'
export const FORGOT = '/api/auth/forgot-password'
export const RESET = '/api/auth/reset-password'
export const CHANGE = '/api/customers/me/password'
export const LOGIN = '/api/auth/login'
export const REFRESH = '/api/auth/refresh'
export const RESET_MAIL = 'password-reset'
export const RESET_REQUESTED = 'customer.password_reset_requested.v1'
export const SAME_ANSWER = { data: { sent: 'if-matched' } }
export const RESET_TTL_MS = 15 * 60_000
/** A reset link: the store's URL, the page, and 32 random bytes as base64url in the fragment. */
export const RESET_LINK =
  /^https:\/\/shop\.test\/account\/reset-password#token=([A-Za-z0-9_-]{43})$/
const REFRESH_COOKIE = 'nymbal.refresh'
const RAISED = { requests: 100_000, window: '1m', action: 'block' } as const

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** A token of the shape the store mints, which it never issued. */
export const neverIssued = (): string => randomBytes(32).toString('base64url')

export interface OpenKernel {
  configure: (config: NymbalConfig) => NymbalConfig
  appOptions: {
    adapters?: { email: EmailAdapter }
    relay?: { retryDelayMs?: number; now?: () => Date }
  }
  logger: Kernel['logger']
}

/** Opens a kernel on a database of its own, migrated to the newest migration. */
export type OpenStore = (opts: OpenKernel) => Promise<Kernel>

export interface Capture {
  adapter: EmailAdapter
  /** Accepted sends, in order. */
  sent: TransactionalEmail[]
  /** Every call, accepted or refused. */
  attempts: TransactionalEmail[]
  /** Address → how many more sends to it the adapter refuses. */
  refuse: Map<string, number>
}

function capture(): Capture {
  const sent: TransactionalEmail[] = []
  const attempts: TransactionalEmail[] = []
  const refuse = new Map<string, number>()
  const adapter: EmailAdapter = {
    kind: 'email',
    providerName: 'password-capture',
    capabilities: () => ['transactional'],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' }),
    async sendTransactional(message) {
      attempts.push(message)
      const left = refuse.get(message.to) ?? 0
      if (left > 0) {
        refuse.set(message.to, left - 1)
        throw new Error(`the capture refuses ${message.to}`)
      }
      sent.push(message)
      return { messageId: `capture-${sent.length}`, accepted: true }
    },
    syncCustomerToList: async () => undefined,
    removeCustomerFromList: async () => undefined,
  }
  return { adapter, sent, attempts, refuse }
}

export interface PasswordStore {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  mail: Capture
  /** Every line the kernel logged, at every level, as JSON. */
  logs: string[]
  base: string
  /** The CSRF pair a browser on the storefront holds. */
  csrf: { cookie: string; header: string }
  /** How far the relay's clock runs ahead of real time: moved past a retry's wait to let it run. */
  clock: { offset: number }
  close(): Promise<void>
}

export interface StoreOptions {
  /** The store's URL; null leaves `store.url` unset. */
  storeUrl?: string | null
  /** A failed delivery waits a minute for its retry, until the clock is moved. */
  retry?: boolean
  /** Set after the schema has parsed the config, so it may be shorter than the schema allows. */
  accessTtl?: string
  /** Rules of `security.rateLimit` in place of the raised ones. */
  rateLimit?: (config: NymbalConfig) => NymbalConfig['security']['rateLimit']
}

const RETRY_DELAY_MS = 60_000
const DAY_MS = 24 * 60 * 60_000

export async function openPasswordStore(
  open: OpenStore,
  opts: StoreOptions = {},
): Promise<PasswordStore> {
  const mail = capture()
  const logs: string[] = []
  const clock = { offset: 0 }
  const logger = createLogger({
    pretty: false,
    level: 'trace',
    destination: { write: (line: string) => void logs.push(line) },
  })
  const storeUrl = opts.storeUrl === undefined ? STORE_URL : opts.storeUrl
  const configure = (config: NymbalConfig): NymbalConfig => {
    const rateLimit = opts.rateLimit?.(config) ?? {
      ...config.security.rateLimit,
      [FORGOT]: RAISED,
      [RESET]: RAISED,
      [CHANGE]: RAISED,
    }
    // Parsed again as loadConfig parses a store's file, so the schema's own handling of the URL applies.
    const parsed = nymbalConfigSchema.parse({
      ...config,
      store: {
        ...config.store,
        ...(storeUrl !== null && { url: storeUrl }),
      },
      commerce: { ...config.commerce, email: { provider: 'custom' } },
      security: { ...config.security, rateLimit },
    })
    if (opts.accessTtl === undefined) return parsed
    return {
      ...parsed,
      security: {
        ...parsed.security,
        auth: { ...parsed.security.auth, accessTtl: opts.accessTtl },
      },
    }
  }
  const k = await open({
    configure,
    appOptions: {
      adapters: { email: mail.adapter },
      ...(opts.retry === true && {
        relay: { retryDelayMs: RETRY_DELAY_MS, now: () => new Date(Date.now() + clock.offset) },
      }),
    },
    logger,
  })
  const served = await serveKernel(k)
  const shop = await primedShopper(served.baseUrl)
  const token = shop.jar.get('nymbal.csrf')!
  const raw = openRaw(k.dialect, k.target)
  return {
    k,
    served,
    raw,
    mail,
    logs,
    base: served.baseUrl,
    csrf: { cookie: `nymbal.csrf=${token}`, header: token },
    clock,
    async close() {
      await raw.close()
      await served.stop()
    },
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Answer {
  status: number
  text: string
  headers: Headers
  body: {
    data?: {
      customer?: { id: string; email: string }
      accessToken?: string
      expiresIn?: number
      sent?: string
    }
    error?: { code: string; message: string }
  }
  /** The refresh cookie the answer set, if any. */
  refreshCookie: string | undefined
}

export interface CallOptions {
  /** A bearer token. */
  bearer?: string
  /** More cookies, beside the CSRF cookie. */
  cookies?: Record<string, string>
  /** The client address, as the loopback proxy forwards it. */
  forwardedFor?: string
}

export async function call(
  s: PasswordStore,
  method: string,
  path: string,
  body?: unknown,
  opts: CallOptions = {},
): Promise<Answer> {
  const cookies = [
    s.csrf.cookie,
    ...Object.entries(opts.cookies ?? {}).map(([name, value]) => `${name}=${value}`),
  ]
  const res = await fetch(new URL(path, s.base), {
    method,
    headers: {
      accept: 'application/json',
      cookie: cookies.join('; '),
      'x-csrf-token': s.csrf.header,
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(opts.bearer !== undefined && { authorization: `Bearer ${opts.bearer}` }),
      ...(opts.forwardedFor !== undefined && { 'x-forwarded-for': opts.forwardedFor }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: Answer['body'] = {}
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Answer['body'])
  } catch {
    // A non-JSON answer (a 404 page) leaves the body empty; the status says what happened.
  }
  const refreshCookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((pair) => pair.startsWith(`${REFRESH_COOKIE}=`))
    ?.slice(REFRESH_COOKIE.length + 1)
  return { status: res.status, text, headers: res.headers, body: parsed, refreshCookie }
}

export const forgot = (s: PasswordStore, email: string, opts?: CallOptions) =>
  call(s, 'POST', FORGOT, { email }, opts)

export const reset = (s: PasswordStore, token: string, password: string, opts?: CallOptions) =>
  call(s, 'POST', RESET, { token, password }, opts)

export const change = (
  s: PasswordStore,
  bearer: string | undefined,
  currentPassword: string,
  newPassword: string,
  opts: CallOptions = {},
) =>
  call(
    s,
    'PATCH',
    CHANGE,
    { currentPassword, newPassword },
    { ...opts, ...(bearer !== undefined && { bearer }) },
  )

export const login = (s: PasswordStore, email: string, password: string, opts?: CallOptions) =>
  call(s, 'POST', LOGIN, { email, password }, opts)

export const refresh = (s: PasswordStore, refreshToken: string) =>
  call(s, 'POST', REFRESH, { refreshToken })

export const me = (s: PasswordStore, accessToken: string) =>
  call(s, 'GET', '/api/customers/me', undefined, { bearer: accessToken })

/** What an answer said: its status and error code. */
export const said = (a: Answer): [number, string | undefined] => [a.status, a.body.error?.code]

export function jtiOf(token: string): string {
  return decodeJwt(token).jti as string
}

// ─── Customers ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Shopper {
  customerId: string
  email: string
  password: string
  accessToken: string
  refreshToken: string
}

/** A customer registered through the service, signed in once by registering. */
export async function registered(s: PasswordStore, tag = 'shopper'): Promise<Shopper> {
  const email = `${tag}-${randomUUID().slice(0, 8)}@reset.test`
  const password = `correct-horse-${randomUUID().slice(0, 8)}`
  const { customer, tokens } = await s.k.services.auth.register({ email, password })
  return {
    customerId: customer.id,
    email,
    password,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  }
}

// ─── Rows, events, mail and logs ──────────────────────────────────────────────────────────────────────────────────

export interface ResetRow {
  id: string
  customer_id: string
  token_hash: string
  expires_at: unknown
  created_at: unknown
}

export const resetRowsOf = (s: PasswordStore, customerId: string): Promise<ResetRow[]> =>
  s.raw.rows<ResetRow>(
    'SELECT id, customer_id, token_hash, expires_at, created_at FROM password_reset_tokens WHERE customer_id = ? ORDER BY id',
    [customerId],
  )

export const allResetRows = (s: PasswordStore): Promise<number> =>
  s.raw.count('password_reset_tokens')

/** A timestamp column as epoch ms, however the dialect returns it. */
export function msOf(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return Date.parse(String(value))
}

export interface CustomerRow {
  password_hash: string
  requires_password_reset: unknown
}

export const customerRowOf = (s: PasswordStore, id: string): Promise<CustomerRow> =>
  s.raw.one<CustomerRow>(
    'SELECT password_hash, requires_password_reset FROM customers WHERE id = ?',
    [id],
  )

/** A boolean column as stored: 0/1 in SQLite, a boolean in Postgres. */
export const truthy = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 't'

export interface RefreshRow {
  id: string
  revoked_at: unknown
  replaced_by_jti: string | null
}

export const refreshRowsOf = (s: PasswordStore, customerId: string): Promise<RefreshRow[]> =>
  s.raw.rows<RefreshRow>(
    'SELECT id, CAST(revoked_at AS TEXT) AS revoked_at, replaced_by_jti FROM refresh_tokens WHERE customer_id = ? ORDER BY id',
    [customerId],
  )

export const liveRefreshOf = async (s: PasswordStore, customerId: string): Promise<string[]> =>
  (await refreshRowsOf(s, customerId)).filter((r) => r.revoked_at === null).map((r) => r.id)

/** Everything a refused write must leave as it was: the customer's row, sessions and reset rows. */
export async function stateOf(s: PasswordStore, customerId: string) {
  return {
    customer: await s.raw.one<Record<string, unknown>>('SELECT * FROM customers WHERE id = ?', [
      customerId,
    ]),
    sessions: await refreshRowsOf(s, customerId),
    resets: await resetRowsOf(s, customerId),
  }
}

export const resetMailsTo = (s: PasswordStore, to: string): TransactionalEmail[] =>
  s.mail.sent.filter((m) => m.template === RESET_MAIL && m.to === to)

/** The token in a reset mail's link; the journey depends on it. */
export function tokenIn(mail: TransactionalEmail | undefined): string {
  const url = String(mail?.vars['resetUrl'] ?? '')
  const match = RESET_LINK.exec(url)
  expect(match, `the reset link: ${url}`).not.toBeNull()
  return match![1]!
}

/** Waits until the outbox has handed every event to the bus, so every send that will happen has happened. */
export async function delivered(s: PasswordStore): Promise<void> {
  await vi.waitFor(
    async () => {
      const open = (await eventRows(s.raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
      expect(open.map((r) => r.type)).toEqual([])
    },
    { timeout: 15_000, interval: 20 },
  )
}

/** The pass in flight and the one it asked for have finished; an event waiting out its retry delay is still waiting. */
export async function settled(s: PasswordStore): Promise<void> {
  await s.k.app.relay.drain()
  await s.k.app.relay.drain()
}

/** The relay's clock moved past every wait, then a drain: each failed event is tried once more. */
export async function retried(s: PasswordStore): Promise<void> {
  s.clock.offset += DAY_MS
  await settled(s)
}

/** A registered customer's mailed reset token: one forgot request, delivered, and the one mail it sent. */
export async function mailedToken(s: PasswordStore, email: string): Promise<string> {
  const before = resetMailsTo(s, email).length
  const answer = await forgot(s, email)
  expect(answer.status, answer.text).toBe(202)
  await delivered(s)
  const mails = resetMailsTo(s, email)
  expect(mails.length, `reset mails to ${email}`).toBe(before + 1)
  return tokenIn(mails.at(-1))
}

/** The names of the tables any column of which holds `needle`, as a second connection reads every row. */
export async function tablesHolding(s: PasswordStore, needle: string): Promise<string[]> {
  const tables =
    s.k.dialect === 'sqlite'
      ? await s.raw.rows<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
      : await s.raw.rows<{ name: string }>(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        )
  const found: string[] = []
  for (const { name } of tables) {
    const rows = await s.raw.rows<Record<string, unknown>>(`SELECT * FROM "${name}"`)
    const text = JSON.stringify(rows, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    )
    if (text.includes(needle)) found.push(name)
  }
  return found
}

/** The log lines that hold `needle`. */
export const logLinesHolding = (s: PasswordStore, needle: string): string[] =>
  s.logs.filter((line) => line.includes(needle))

/** The warn lines logged so far (pino's level 40). */
export const warnLines = (s: PasswordStore): string[] =>
  s.logs.filter((line) => /"level":40\b/.test(line))
