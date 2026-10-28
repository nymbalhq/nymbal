import { randomBytes, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import pg from 'pg'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  renderEmailTemplate,
  type EmailAdapter,
  type NymbalEvent,
  type TransactionalEmail,
} from '@nymbalhq/types'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../../src/event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../../../src/index.js'
import { createLogger } from '../../../src/logger.js'
import { buildRepositories } from '../../../src/repositories/index.js'
import { createProductService } from '../../../src/services/product-service.js'
import { wirePublisher } from '../../../src/tests/publisher.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { kernelConfig, MIGRATIONS_ROOT, type Dialect, type Kernel } from '../kernel.js'
import { eventRows } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'

// Back-in-stock and price-drop alerts on one dialect, over HTTP against a kernel built from `src/` whose email slot is
// a capturing adapter of the project's own (`custom`, so the store delivers). A shopper subscribes from a storefront
// origin the store allows, follows the confirmation's link, and is mailed once when the variant comes back, or each
// time its price falls below the last price the subscription was told; every email carries an unsubscribe link. Mail
// is read from the adapter the handler calls, rows from a second connection, events from the log.

export interface OpenKernel {
  configure: (config: NymbalConfig) => NymbalConfig
  appOptions: {
    adapters?: { email: EmailAdapter }
    relay?: { retryDelayMs?: number; now?: () => Date }
  }
  logger: Kernel['logger']
}

export interface AlertsSuiteOptions {
  /** A kernel on a database of its own, migrated to the newest migration. */
  open(opts: OpenKernel): Promise<Kernel>
  /** An empty database the suite migrates itself: a SQLite file path or a Postgres URL. */
  fresh(): Promise<string>
  propertyRuns: number
}

const SHOP_A = 'http://shop-a.test'
const SHOP_B = 'http://shop-b.test'
const ORIGINS = [SHOP_A, SHOP_B]
const SUBSCRIBE = '/api/alerts/subscribe'
const CONFIRM = '/api/alerts/confirm'
const UNSUBSCRIBE = '/api/alerts/unsubscribe'
const KIND = 'back_in_stock'
const CONFIRM_MAIL = 'alert-confirm'
const ALERT_MAIL = 'alert-back-in-stock'
const PRICE_DROP = 'price_drop'
const PRICE_CONFIRM_MAIL = 'alert-confirm-price-drop'
const PRICE_ALERT_MAIL = 'alert-price-drop'
const PRICE_CHANGED = 'product.variant_price_changed.v1'
/** The price-drop store's currency: no minor-unit digits, so an amount formatted as if in pence is plainly wrong. */
const PRICE_CURRENCY = 'JPY'
const TABLE = 'alert_subscriptions'

// ─── The store under test ─────────────────────────────────────────────────────────────────────────────────────────

interface Capture {
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
    providerName: 'alerts-capture',
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

function alertsConfig(email: 'custom' | 'native', origins: string[], currency?: string) {
  return (config: NymbalConfig): NymbalConfig =>
    ({
      ...config,
      ...(currency !== undefined && { store: { ...config.store, currency } }),
      commerce: {
        ...config.commerce,
        ...(email === 'custom' ? { email: { provider: 'custom' } } : {}),
      },
      http: { ...config.http, cors: { ...config.http.cors, allowedOrigins: origins } },
      security: {
        ...config.security,
        // The suite subscribes many times from 127.0.0.1; the built-in bound is proven in the http package.
        rateLimit: {
          ...config.security.rateLimit,
          [SUBSCRIBE]: { requests: 100_000, window: '1m', action: 'block' },
        },
      },
    }) as NymbalConfig
}

interface Store {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  mail: Capture
  /** The kernel's log lines at warn and above, as JSON. */
  logs: string[]
  base: string
  /** The CSRF pair a browser on the storefront holds. */
  csrf: Record<string, string>
  /** How far the relay's clock runs ahead of real time: moved past a retry's wait to let it run. */
  clock: { offset: number }
  close(): Promise<void>
}

/** The relay's wait before a retry, in a store opened with `retry`: a failed first delivery stays failed until the clock moves. */
const RETRY_DELAY_MS = 60_000
const DAY_MS = 24 * 60 * 60_000
/** The relay's default. */
const MAX_ATTEMPTS = 5

async function openStore(
  options: AlertsSuiteOptions,
  opts: {
    email?: 'custom' | 'native'
    origins?: string[]
    currency?: string
    retry?: boolean
  } = {},
): Promise<Store> {
  const mail = capture()
  const logs: string[] = []
  const clock = { offset: 0 }
  const logger = createLogger({
    pretty: false,
    level: 'warn',
    destination: { write: (line: string) => void logs.push(line) },
  })
  const email = opts.email ?? 'custom'
  const k = await options.open({
    configure: alertsConfig(email, opts.origins ?? ORIGINS, opts.currency),
    appOptions: {
      ...(email === 'custom' && { adapters: { email: mail.adapter } }),
      ...(opts.retry === true && {
        relay: {
          retryDelayMs: RETRY_DELAY_MS,
          now: () => new Date(Date.now() + clock.offset),
        },
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
    csrf: { cookie: `nymbal.csrf=${token}`, 'x-csrf-token': token },
    clock,
    async close() {
      await raw.close()
      await served.stop()
    },
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Answer {
  status: number
  text: string
  headers: Headers
  body: { data?: Record<string, unknown>; error?: { code: string; message: string } }
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const res = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: Answer['body'] = {}
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Answer['body'])
  } catch {
    // A non-JSON answer (a 404 page) leaves the body empty; the status says what happened.
  }
  return { status: res.status, text, headers: res.headers, body: parsed }
}

function subscribe(
  s: Store,
  email: string,
  variantId: string,
  origin: string | null = SHOP_A,
  kind: string = KIND,
): Promise<Answer> {
  return post(
    s.base,
    SUBSCRIBE,
    { email, variantId, kind },
    { ...s.csrf, ...(origin === null ? {} : { origin }) },
  )
}

/** Confirm and unsubscribe as a template page's server calls them: no cookie, no CSRF pair, the token the credential. */
const confirm = (s: Store, token: string): Promise<Answer> => post(s.base, CONFIRM, { token })
const unsubscribe = (s: Store, token: string): Promise<Answer> =>
  post(s.base, UNSUBSCRIBE, { token })

/** What an answer said: its data's status, or its error code. */
const said = (a: Answer): unknown => a.body.data?.['status'] ?? a.body.error?.code ?? a.text

/** A subscribe the store accepts; the journey depends on it. */
async function subscribed(
  s: Store,
  email: string,
  variantId: string,
  origin: string = SHOP_A,
  kind: string = KIND,
): Promise<void> {
  const res = await subscribe(s, email, variantId, origin, kind)
  expect(res.status, `subscribe ${email} (${kind}): ${res.text.slice(0, 300)}`).toBe(202)
}

// ─── Rows, events and mail ────────────────────────────────────────────────────────────────────────────────────────

interface Row {
  id: string
  email: string
  kind: string
  variant_id: string
  product_id: string
  status: string
  confirm_token: string
  unsubscribe_token: string
  origin: string
  baseline_price_minor: number | string | null
  updated_at: unknown
}

const norm = (email: string): string => email.trim().toLowerCase()

function rowsWhere(s: Store, where: string, params: unknown[]): Promise<Row[]> {
  return s.raw.rows<Row>(
    `SELECT id, email, kind, variant_id, product_id, status, confirm_token, unsubscribe_token, origin,
            baseline_price_minor, updated_at
       FROM ${TABLE} WHERE ${where}`,
    params,
  )
}

const rowsFor = (s: Store, email: string, variantId: string, kind = KIND): Promise<Row[]> =>
  rowsWhere(s, 'email = ? AND variant_id = ? AND kind = ?', [norm(email), variantId, kind])

/** The one row for an address, variant and kind; the test depends on it. */
async function rowOf(s: Store, email: string, variantId: string, kind = KIND): Promise<Row> {
  const rows = await rowsFor(s, email, variantId, kind)
  expect(rows.length, `${TABLE} ${kind} rows for ${norm(email)}`).toBe(1)
  return rows[0]!
}

/** A row's baseline as a number, whichever way the driver hands the integer back. */
const baselineOf = (row: Row): number | null =>
  row.baseline_price_minor === null ? null : Number(row.baseline_price_minor)

/** Every (email, variant, kind) the table holds more than once. */
function duplicates(s: Store): Promise<unknown[]> {
  return s.raw.rows(
    `SELECT email, variant_id, kind, count(*) AS n FROM ${TABLE} GROUP BY email, variant_id, kind HAVING count(*) > 1`,
  )
}

/** A timestamp column as an instant, whichever way the dialect and schema store it. */
function instant(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n
  return Date.parse(String(value))
}

function positional(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${(n += 1)}`)
}

/** One write on a connection of its own (the raw reader is read-only). */
async function write(s: Store, sql: string, params: unknown[]): Promise<void> {
  if (s.k.dialect === 'sqlite') {
    const db = new Database(s.k.target)
    try {
      db.prepare(sql).run(...params)
    } finally {
      db.close()
    }
    return
  }
  const client = new pg.Client({ connectionString: s.k.target })
  await client.connect()
  try {
    await client.query(positional(sql), params)
  } finally {
    await client.end()
  }
}

const LONG_AGO = Date.parse('2001-01-01T00:00:00.000Z')

/** Sets a row's updated_at to 2001, in the representation the column already holds, and returns that instant. */
async function backdate(s: Store, row: Row): Promise<number> {
  const current = row.updated_at
  const old = new Date(LONG_AGO)
  const value =
    current instanceof Date
      ? old
      : typeof current === 'number'
        ? current < 1e12
          ? Math.floor(LONG_AGO / 1000)
          : LONG_AGO
        : old.toISOString()
  await write(s, `UPDATE ${TABLE} SET updated_at = ? WHERE id = ?`, [value, row.id])
  return LONG_AGO
}

/** Waits until the outbox has handed every event to the bus, so every send that will happen has happened. */
async function delivered(s: Store): Promise<void> {
  await vi.waitFor(
    async () => {
      const open = (await eventRows(s.raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
      expect(open.map((r) => r.type)).toEqual([])
    },
    { timeout: 10_000, interval: 20 },
  )
}

/** The pass in flight and the one it asked for have finished; an event waiting out its retry delay is still waiting. */
async function settled(s: Store): Promise<void> {
  await s.k.app.relay.drain()
  await s.k.app.relay.drain()
}

/** The relay's clock moved past every wait, then a drain: each failed event is tried once more. */
async function retried(s: Store): Promise<void> {
  s.clock.offset += DAY_MS
  await settled(s)
}

/** The one event of `type` for the variant appended since `afterSeq`; the test depends on it. */
async function triggerOf(s: Store, type: string, variantId: string, afterSeq: number) {
  const rows = (await eventRows(s.raw, 'seq > ? AND type = ?', [afterSeq, type])).filter(
    (e) => (e.envelope.payload as { variantId?: string }).variantId === variantId,
  )
  expect(rows.length, `${type} events for ${variantId}`).toBe(1)
  return rows[0]!
}

/** Where an event is in its delivery: [attempts, delivered, dead]. */
async function deliveryOf(s: Store, id: string): Promise<[number, boolean, boolean]> {
  const [row] = await eventRows(s.raw, 'id = ?', [id])
  return [row!.attempts, row!.deliveredAt != null, row!.deadAt != null]
}

/** How many alert.sent.v1 events name each row and the trigger. */
async function sentPerRow(s: Store, rowIds: string[], triggerId: string): Promise<number[]> {
  const sent = (await eventRows(s.raw, 'type = ?', ['alert.sent.v1'])).map(
    (e) => e.envelope.payload as { subscriptionId?: string; triggerEventId?: string },
  )
  return rowIds.map(
    (id) => sent.filter((p) => p.subscriptionId === id && p.triggerEventId === triggerId).length,
  )
}

async function lastSeq(s: Store): Promise<number> {
  const [row] = await s.raw.rows<{ n: number | string | null }>('SELECT max(seq) AS n FROM events')
  return Number(row?.n ?? 0)
}

const mailsTo = (s: Store, email: string, template?: string): TransactionalEmail[] =>
  s.mail.sent.filter(
    (m) => m.to === norm(email) && (template === undefined || m.template === template),
  )

/** A link's origin and token; the link must be to `path`. */
function link(value: unknown, path: string): { origin: string; token: string } {
  const url = new URL(String(value))
  expect(url.pathname, String(value)).toBe(path)
  return { origin: url.origin, token: url.searchParams.get('token') ?? '' }
}

/** The tokens of the newest confirmation to an address. */
function latestConfirmation(
  s: Store,
  email: string,
  template: string = CONFIRM_MAIL,
): { confirm: string; unsubscribe: string } {
  const mails = mailsTo(s, email, template)
  expect(mails.length, `confirmations to ${norm(email)}`).toBeGreaterThan(0)
  const last = mails.at(-1)!
  return {
    confirm: link(last.vars['confirmUrl'], '/alerts/confirm').token,
    unsubscribe: link(last.vars['unsubscribeUrl'], '/alerts/unsubscribe').token,
  }
}

const unknownToken = (): string => randomBytes(32).toString('base64url')
const freshEmail = (role: string): string => `${role}-${randomUUID()}@alerts.test`

/** A fresh address of exactly `length` characters, its domain padded with labels of at most 63. */
function freshEmailOfLength(role: string, length: number): string {
  const [local, domain] = freshEmail(role).split('@') as [string, string]
  let host = domain
  let room = length - local.length - 1 - host.length
  while (room > 0) {
    const label = room > 64 ? (room === 65 ? 62 : 63) : room - 1
    host = `${'x'.repeat(label)}.${host}`
    room = length - local.length - 1 - host.length
  }
  return `${local}@${host}`
}

interface Seeded {
  productId: string
  variantId: string
  slug: string
  name: string
}

async function seedProduct(k: Kernel, stock: number): Promise<Seeded> {
  const tag = randomUUID().slice(0, 8)
  const name = `Alert Widget ${tag}`
  const slug = `alert-${tag}`
  const product = await k.services.product.create({
    slug,
    name,
    description: '',
    status: 'active',
    variants: [
      {
        sku: `ALERT-${tag}`,
        name: 'Default',
        priceMinor: 1500,
        stock,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  return { productId: product.id, variantId: product.variants[0]!.id, slug, name }
}

/** Subscribed, delivered and confirmed: an active row. */
async function activate(
  s: Store,
  email: string,
  variantId: string,
  origin = SHOP_A,
): Promise<void> {
  await subscribed(s, email, variantId, origin)
  await delivered(s)
  const res = await confirm(s, latestConfirmation(s, email).confirm)
  expect(res.status, `confirm ${email}: ${res.text.slice(0, 300)}`).toBe(200)
  await delivered(s)
}

async function restock(s: Store, variantId: string, delta: number): Promise<void> {
  await s.k.services.inventory.adjustStock(variantId, delta, 'manual', 'alerts-suite')
}

/** Subscribed for a price drop, delivered and confirmed: an active price-drop row. */
async function activatePriceDrop(
  s: Store,
  email: string,
  variantId: string,
  origin = SHOP_A,
): Promise<void> {
  await subscribed(s, email, variantId, origin, PRICE_DROP)
  await delivered(s)
  const res = await confirm(s, latestConfirmation(s, email, PRICE_CONFIRM_MAIL).confirm)
  expect(res.status, `confirm ${email}: ${res.text.slice(0, 300)}`).toBe(200)
  await delivered(s)
}

/** The variant's price set through the product command, as the admin's save sets it. */
async function reprice(s: Store, p: Seeded, priceMinor: number): Promise<void> {
  await s.k.services.product.update(p.productId, {
    variants: [{ id: p.variantId, priceMinor }],
  })
}

/** An amount in minor units as money in `currency`, independently of the kernel's formatter. */
function money(minor: number, currency: string): string {
  const format = new Intl.NumberFormat('en-GB', { style: 'currency', currency })
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2
  return format.format(minor / 10 ** digits)
}

/** The price events the log holds for a variant, by id. */
async function priceEventIds(s: Store, variantId: string): Promise<string[]> {
  return (await eventRows(s.raw, 'type = ?', [PRICE_CHANGED]))
    .filter((e) => (e.envelope.payload as { variantId?: string }).variantId === variantId)
    .map((e) => e.id)
}

// ─── Addresses that differ only in case and spaces ────────────────────────────────────────────────────────────────

type Form = { left: number; right: number; pattern: 'upper' | 'alternate' | 'first' }

const arbForm: fc.Arbitrary<Form> = fc.record({
  left: fc.integer({ min: 1, max: 3 }),
  right: fc.integer({ min: 0, max: 3 }),
  pattern: fc.constantFrom('upper', 'alternate', 'first'),
})

function vary(email: string, form: Form): string {
  const cased =
    form.pattern === 'upper'
      ? email.toUpperCase()
      : form.pattern === 'first'
        ? email.charAt(0).toUpperCase() + email.slice(1)
        : [...email].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('')
  return `${' '.repeat(form.left)}${cased}${' '.repeat(form.right)}`
}

// ─── The model: subscribe, confirm, unsubscribe, and one alert per activation ────────────────────────────────────────

type State = 'none' | 'pending' | 'active' | 'unsubscribed' | 'fired'

type Op =
  | { kind: 'subscribe'; who: number; form: Form | null; origin: number }
  | { kind: 'burst'; who: number; k: number }
  | { kind: 'confirm'; who: number }
  | { kind: 'unsubscribe'; who: number }
  | { kind: 'restock'; delta: number }
  | { kind: 'sellout' }

interface Shopper {
  email: string
  state: State
  origin: string | null
  confirmations: number
  /** The origin of each alert sent, in order. */
  alerts: string[]
}

const PEOPLE = 3

const arbWho = fc.integer({ min: 0, max: PEOPLE - 1 })
const arbSubscribe = fc.record({
  kind: fc.constant('subscribe' as const),
  who: arbWho,
  form: fc.option(arbForm, { nil: null }),
  origin: fc.integer({ min: 0, max: ORIGINS.length - 1 }),
})
const arbConfirm = fc.record({ kind: fc.constant('confirm' as const), who: arbWho })
const arbUnsubscribe = fc.record({ kind: fc.constant('unsubscribe' as const), who: arbWho })
const arbRestock = fc.record({
  kind: fc.constant('restock' as const),
  delta: fc.integer({ min: 1, max: 3 }),
})
const arbSellout = fc.constant({ kind: 'sellout' as const })

class Machine {
  readonly people: Shopper[]
  stock = 0

  constructor(
    readonly s: Store,
    readonly product: Seeded,
  ) {
    const tag = randomUUID().slice(0, 8)
    this.people = Array.from({ length: PEOPLE }, (_, i) => ({
      email: `shopper${i}-${tag}@alerts.test`,
      state: 'none' as State,
      origin: null,
      confirmations: 0,
      alerts: [],
    }))
  }

  async apply(op: Op): Promise<void> {
    const { s, product } = this
    if (op.kind === 'subscribe' || op.kind === 'burst') {
      const p = this.people[op.who]!
      const origin = op.kind === 'subscribe' ? ORIGINS[op.origin]! : SHOP_A
      const email = op.kind === 'subscribe' && op.form !== null ? vary(p.email, op.form) : p.email
      const k = op.kind === 'burst' ? op.k : 1
      const answers = await Promise.all(
        Array.from({ length: k }, () => subscribe(s, email, product.variantId, origin)),
      )
      expect(
        answers.map((a) => a.status),
        `${JSON.stringify(op)}: ${answers[0]?.text}`,
      ).toEqual(answers.map(() => 202))
      if (p.state !== 'active') {
        p.state = 'pending'
        p.origin = origin
        p.confirmations += k
      }
    } else if (op.kind === 'confirm') {
      const p = this.people[op.who]!
      if (mailsTo(s, p.email, CONFIRM_MAIL).length === 0) return
      const res = await confirm(s, latestConfirmation(s, p.email).confirm)
      const accepted = p.state === 'pending' || p.state === 'active'
      expect([res.status, said(res)], JSON.stringify(op)).toEqual(
        accepted ? [200, 'active'] : [404, 'alerts.link_invalid'],
      )
      if (accepted) p.state = 'active'
    } else if (op.kind === 'unsubscribe') {
      const p = this.people[op.who]!
      const last = mailsTo(s, p.email).at(-1)
      if (last === undefined) return
      const res = await unsubscribe(
        s,
        link(last.vars['unsubscribeUrl'], '/alerts/unsubscribe').token,
      )
      expect([res.status, said(res)], JSON.stringify(op)).toEqual([200, 'unsubscribed'])
      p.state = 'unsubscribed'
    } else if (op.kind === 'restock') {
      if (this.stock === 0) {
        for (const p of this.people) {
          if (p.state !== 'active') continue
          p.alerts.push(p.origin!)
          p.state = 'fired'
        }
      }
      await restock(s, product.variantId, op.delta)
      this.stock += op.delta
    } else if (this.stock > 0) {
      await restock(s, product.variantId, -this.stock)
      this.stock = 0
    }
    await delivered(s)
  }
}

// ─── The model: price-drop subscriptions and the baseline rule ──────────────────────────────────────────────────────

type PriceOp =
  | { kind: 'subscribe'; who: number; origin: number }
  | { kind: 'confirm'; who: number }
  | { kind: 'unsubscribe'; who: number }
  | { kind: 'price'; move: 'up' | 'down' | 'equal'; step: number }

interface Watcher {
  email: string
  state: Exclude<State, 'fired'>
  origin: string | null
  /** The price the row was last told, or saw when it subscribed. */
  baseline: number | null
  confirmations: number
  /** Each alert sent: the old and new price, and the origin its links are at. */
  alerts: Array<{ previous: number; price: number; origin: string }>
}

const arbPriceSubscribe = fc.record({
  kind: fc.constant('subscribe' as const),
  who: arbWho,
  origin: fc.integer({ min: 0, max: ORIGINS.length - 1 }),
})
const arbPrice = fc.record({
  kind: fc.constant('price' as const),
  move: fc.constantFrom('up' as const, 'down' as const, 'equal' as const),
  step: fc.integer({ min: 1, max: 400 }),
})

class PriceMachine {
  readonly people: Watcher[]
  price: number

  constructor(
    readonly s: Store,
    readonly product: Seeded,
    startPrice: number,
  ) {
    const tag = randomUUID().slice(0, 8)
    this.price = startPrice
    this.people = Array.from({ length: PEOPLE }, (_, i) => ({
      email: `watcher${i}-${tag}@alerts.test`,
      state: 'none' as const,
      origin: null,
      baseline: null,
      confirmations: 0,
      alerts: [],
    }))
  }

  async apply(op: PriceOp): Promise<void> {
    const { s, product } = this
    if (op.kind === 'subscribe') {
      const p = this.people[op.who]!
      const origin = ORIGINS[op.origin]!
      const res = await subscribe(s, p.email, product.variantId, origin, PRICE_DROP)
      expect(res.status, `${JSON.stringify(op)}: ${res.text.slice(0, 300)}`).toBe(202)
      if (p.state !== 'active') {
        if (p.state === 'none' || p.state === 'unsubscribed') p.baseline = this.price
        p.state = 'pending'
        p.origin = origin
        p.confirmations += 1
      }
    } else if (op.kind === 'confirm') {
      const p = this.people[op.who]!
      if (mailsTo(s, p.email, PRICE_CONFIRM_MAIL).length === 0) return
      const res = await confirm(s, latestConfirmation(s, p.email, PRICE_CONFIRM_MAIL).confirm)
      const accepted = p.state === 'pending' || p.state === 'active'
      expect([res.status, said(res)], JSON.stringify(op)).toEqual(
        accepted ? [200, 'active'] : [404, 'alerts.link_invalid'],
      )
      if (accepted) p.state = 'active'
    } else if (op.kind === 'unsubscribe') {
      const p = this.people[op.who]!
      const last = mailsTo(s, p.email).at(-1)
      if (last === undefined) return
      const res = await unsubscribe(
        s,
        link(last.vars['unsubscribeUrl'], '/alerts/unsubscribe').token,
      )
      expect([res.status, said(res)], JSON.stringify(op)).toEqual([200, 'unsubscribed'])
      p.state = 'unsubscribed'
    } else {
      const next =
        op.move === 'up'
          ? this.price + op.step
          : op.move === 'down'
            ? Math.max(0, this.price - op.step)
            : this.price
      if (next !== this.price) {
        for (const p of this.people) {
          if (p.state !== 'active' || p.baseline === null) continue
          if (next < this.price && next < p.baseline) {
            p.alerts.push({ previous: this.price, price: next, origin: p.origin! })
            p.baseline = next
          }
        }
      }
      await reprice(s, product, next)
      this.price = next
    }
    await delivered(s)
  }
}

// ─── The migration ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A copy of the migrations folder holding every migration before the first one that mentions the alerts table: the
 * schema as it stood before this feature, whatever number its migration takes.
 */
function migrationsBeforeAlerts(dialect: Dialect): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'alerts-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  const first = journal.entries.findIndex((entry) =>
    readFileSync(join(from, `${entry.tag}.sql`), 'utf8').includes(TABLE),
  )
  journal.entries = first === -1 ? journal.entries : journal.entries.slice(0, first)
  for (const entry of journal.entries) {
    cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
  }
  writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

function storageOf(dialect: Dialect, target: string) {
  return dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
}

async function migrate(dialect: Dialect, target: string, root: string): Promise<void> {
  const store = createCommandStore(kernelConfig(dialect), storageOf(dialect, target))
  try {
    await runMigrations(store, { migrationsRoot: root })
  } finally {
    await store.close()
  }
}

/** A product with two variants and its events, written by the product service on the schema as it stands. */
async function seedAt(dialect: Dialect, target: string): Promise<void> {
  const store = createCommandStore(kernelConfig(dialect), storageOf(dialect, target))
  try {
    const logger = createLogger({ pretty: false, level: 'error' })
    const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    const { publisher } = wirePublisher(
      { createEventPublisher, createRelay },
      { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
    )
    const product = createProductService({
      store,
      repos,
      publisher,
      logger,
      currency: kernelConfig(dialect).store.currency,
    })
    const tag = randomUUID().slice(0, 8)
    await product.create({
      slug: `before-alerts-${tag}`,
      name: 'Before Alerts',
      description: '',
      status: 'active',
      variants: [
        {
          sku: `BA-1-${tag}`,
          name: 'One',
          priceMinor: 900,
          stock: 0,
          lowStockThreshold: 0,
          options: [],
        },
        {
          sku: `BA-2-${tag}`,
          name: 'Two',
          priceMinor: 900,
          stock: 4,
          lowStockThreshold: 0,
          options: [],
        },
      ],
    })
  } finally {
    await store.close()
  }
}

/** Every table and its row count, on a connection of its own. */
async function tableCounts(raw: RawReader, dialect: Dialect): Promise<Record<string, number>> {
  const names =
    dialect === 'sqlite'
      ? await raw.rows<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
        )
      : await raw.rows<{ name: string }>(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        )
  const counts: Record<string, number> = {}
  for (const { name } of names) counts[name] = await raw.count(`"${name}"`)
  return counts
}

async function columnsOf(raw: RawReader, dialect: Dialect): Promise<string[]> {
  const rows =
    dialect === 'sqlite'
      ? await raw.rows<{ name: string }>(`SELECT name FROM pragma_table_info('${TABLE}')`)
      : await raw.rows<{ name: string }>(
          'SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?',
          [TABLE],
        )
  return rows.map((r) => r.name).sort()
}

/** Each index on the table as its columns in order, and whether it is unique; the primary key left out. */
async function indexesOf(
  raw: RawReader,
  dialect: Dialect,
): Promise<Array<{ columns: string[]; unique: boolean }>> {
  if (dialect === 'sqlite') {
    const list = await raw.rows<{ name: string; unique: number; origin: string }>(
      `SELECT name, "unique", origin FROM pragma_index_list('${TABLE}')`,
    )
    const out: Array<{ columns: string[]; unique: boolean }> = []
    for (const index of list.filter((i) => i.origin !== 'pk')) {
      const cols = await raw.rows<{ name: string }>(
        `SELECT name FROM pragma_index_info('${index.name}') ORDER BY seqno`,
      )
      out.push({ columns: cols.map((c) => c.name), unique: Number(index.unique) === 1 })
    }
    return out
  }
  const defs = await raw.rows<{ indexdef: string }>(
    'SELECT indexdef FROM pg_indexes WHERE tablename = ?',
    [TABLE],
  )
  return defs
    .filter((d) => !/_pkey\b/.test(d.indexdef))
    .map((d) => ({
      unique: /^CREATE UNIQUE INDEX/i.test(d.indexdef),
      columns: /\(([^)]*)\)/
        .exec(d.indexdef)![1]!
        .split(',')
        .map((c) => c.trim().replace(/"/g, '')),
    }))
}

const sortedIndexes = (indexes: Array<{ columns: string[]; unique: boolean }>): string[] =>
  indexes.map((i) => `${i.unique ? 'unique ' : ''}(${i.columns.join(', ')})`).sort()

// ─── The suite ────────────────────────────────────────────────────────────────────────────────────────────────────

export function alertsSuite(dialect: Dialect, options: AlertsSuiteOptions): void {
  describe(`alerts: subscribe, confirm, unsubscribe and the tokens (${dialect})`, () => {
    let s: Store

    beforeAll(async () => {
      s = await openStore(options)
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    it('AC-2: a subscribe from an allowed Origin answers 202 pending, writes one pending row and one alert.requested.v1, and sends one alert-confirm whose links are at that origin; the row’s two tokens differ and no event carries the address or a token', async () => {
      const p = await seedProduct(s.k, 0)
      const email = freshEmail('ac2')

      const res = await subscribe(s, email, p.variantId, SHOP_B)
      expect(res.status, res.text.slice(0, 300)).toBe(202)
      expect(res.body).toEqual({ data: { status: 'pending' } })
      await delivered(s)

      const row = await rowOf(s, email, p.variantId)
      expect({
        status: row.status,
        kind: row.kind,
        productId: row.product_id,
        origin: row.origin,
      }).toEqual({
        status: 'pending',
        kind: KIND,
        productId: p.productId,
        origin: SHOP_B,
      })
      expect(row.confirm_token).not.toBe(row.unsubscribe_token)

      const requested = (await eventRows(s.raw, 'type = ?', ['alert.requested.v1'])).filter(
        (e) => (e.envelope.payload as { subscriptionId?: string }).subscriptionId === row.id,
      )
      expect(requested.map((e) => e.envelope.payload)).toEqual([
        { subscriptionId: row.id, kind: KIND, variantId: p.variantId, productId: p.productId },
      ])

      const mails = mailsTo(s, email)
      expect(mails.map((m) => m.template)).toEqual([CONFIRM_MAIL])
      const vars = mails[0]!.vars
      expect(link(vars['confirmUrl'], '/alerts/confirm')).toEqual({
        origin: SHOP_B,
        token: row.confirm_token,
      })
      expect(link(vars['unsubscribeUrl'], '/alerts/unsubscribe')).toEqual({
        origin: SHOP_B,
        token: row.unsubscribe_token,
      })
      expect(vars['productName']).toBe(p.name)

      const secrets = [norm(email), row.confirm_token, row.unsubscribe_token]
      const leaking = (await eventRows(s.raw))
        .map((e) => JSON.stringify(e.envelope))
        .filter((text) => secrets.some((secret) => text.includes(secret)))
      expect(leaking).toEqual([])
    })

    it('AC-2: confirm answers 200 active with the kind and product, and again 200; unsubscribe answers 200 unsubscribed, and again 200; confirm after unsubscribe answers 404 alerts.link_invalid', async () => {
      const p = await seedProduct(s.k, 0)
      const email = freshEmail('ac2-life')
      await subscribed(s, email, p.variantId)
      await delivered(s)
      const tokens = latestConfirmation(s, email)

      const first = await confirm(s, tokens.confirm)
      expect(first.status, first.text.slice(0, 300)).toBe(200)
      expect(first.body).toEqual({
        data: { status: 'active', kind: KIND, product: { name: p.name, slug: p.slug } },
      })

      const steps: Array<[string, () => Promise<Answer>]> = [
        ['confirm again', () => confirm(s, tokens.confirm)],
        ['unsubscribe', () => unsubscribe(s, tokens.unsubscribe)],
        ['unsubscribe again', () => unsubscribe(s, tokens.unsubscribe)],
        ['confirm after unsubscribe', () => confirm(s, tokens.confirm)],
      ]
      const seen: Array<[string, number, unknown, string]> = []
      for (const [step, act] of steps) {
        const answer = await act()
        seen.push([step, answer.status, said(answer), (await rowOf(s, email, p.variantId)).status])
      }
      expect(seen).toEqual([
        ['confirm again', 200, 'active', 'active'],
        ['unsubscribe', 200, 'unsubscribed', 'unsubscribed'],
        ['unsubscribe again', 200, 'unsubscribed', 'unsubscribed'],
        ['confirm after unsubscribe', 404, 'alerts.link_invalid', 'unsubscribed'],
      ])
    })

    it('AC-2: a confirm token posted to unsubscribe, an unsubscribe token posted to confirm, and an unknown token each answer 404 alerts.link_invalid; one row’s confirm token activates that row only', async () => {
      const p = await seedProduct(s.k, 0)
      const a = freshEmail('ac2-a')
      const b = freshEmail('ac2-b')
      await subscribed(s, a, p.variantId)
      await subscribed(s, b, p.variantId)
      await delivered(s)
      const ta = latestConfirmation(s, a)
      const stranger = unknownToken()

      const crossed = await Promise.all([
        unsubscribe(s, ta.confirm),
        confirm(s, ta.unsubscribe),
        confirm(s, stranger),
        unsubscribe(s, stranger),
      ])
      expect(crossed.map((r) => [r.status, said(r)])).toEqual(
        crossed.map(() => [404, 'alerts.link_invalid']),
      )
      expect((await rowOf(s, a, p.variantId)).status).toBe('pending')

      const own = await confirm(s, latestConfirmation(s, b).confirm)
      expect(own.status, own.text).toBe(200)
      expect([
        (await rowOf(s, a, p.variantId)).status,
        (await rowOf(s, b, p.variantId)).status,
      ]).toEqual(['pending', 'active'])
    })

    it('AC-2: after a resubscribe the row’s unsubscribe token is unchanged and still unsubscribes from the older email’s link; its confirm token is new, and the old one answers 404', async () => {
      const p = await seedProduct(s.k, 0)
      const email = freshEmail('ac2-again')
      await activate(s, email, p.variantId)
      const before = await rowOf(s, email, p.variantId)
      const older = latestConfirmation(s, email)
      const left = await unsubscribe(s, older.unsubscribe)
      expect(left.status, left.text).toBe(200)

      await subscribed(s, email, p.variantId)
      await delivered(s)
      const after = await rowOf(s, email, p.variantId)
      const newer = latestConfirmation(s, email)

      expect(after.id).toBe(before.id)
      expect(after.status).toBe('pending')
      expect(after.unsubscribe_token).toBe(before.unsubscribe_token)
      expect(newer.unsubscribe).toBe(older.unsubscribe)
      expect(after.confirm_token).not.toBe(before.confirm_token)
      expect(newer.confirm).toBe(after.confirm_token)

      const stale = await confirm(s, older.confirm)
      expect([stale.status, said(stale)]).toEqual([404, 'alerts.link_invalid'])
      expect((await rowOf(s, email, p.variantId)).status).toBe('pending')

      const fresh = await confirm(s, newer.confirm)
      expect([fresh.status, said(fresh)]).toEqual([200, 'active'])
      const viaOldLink = await unsubscribe(s, older.unsubscribe)
      expect([viaOldLink.status, said(viaOldLink)]).toEqual([200, 'unsubscribed'])
      expect((await rowOf(s, email, p.variantId)).status).toBe('unsubscribed')
    })

    it('AC-2: a repeat subscribe on a pending row from another allowed origin sends a confirmation whose links are at the new origin', async () => {
      const p = await seedProduct(s.k, 0)
      const email = freshEmail('ac2-origin')
      await subscribed(s, email, p.variantId, SHOP_A)
      await subscribed(s, email, p.variantId, SHOP_B)
      await delivered(s)

      const origins = mailsTo(s, email, CONFIRM_MAIL).map((m) => [
        link(m.vars['confirmUrl'], '/alerts/confirm').origin,
        link(m.vars['unsubscribeUrl'], '/alerts/unsubscribe').origin,
      ])
      expect(origins).toEqual([
        [SHOP_A, SHOP_A],
        [SHOP_B, SHOP_B],
      ])
      expect((await rowOf(s, email, p.variantId)).origin).toBe(SHOP_B)
    })

    it('AC-2: a missing Origin, or one that is not exactly an allowed origin, answers 400 alerts.origin_not_allowed with no row and no mail', async () => {
      const p = await seedProduct(s.k, 0)
      const forged = [
        null,
        'http://evil.test',
        'https://shop-a.test',
        'http://shop-a.test:8080',
        'http://shop-a.test.evil.test',
        'null',
      ]
      const tried: Array<{ origin: string | null; email: string; answer: Answer }> = []
      for (const origin of forged) {
        const email = freshEmail('ac2-forged')
        tried.push({ origin, email, answer: await subscribe(s, email, p.variantId, origin) })
      }
      await delivered(s)

      expect(tried.map((t) => [t.origin, t.answer.status, said(t.answer)])).toEqual(
        forged.map((origin) => [origin, 400, 'alerts.origin_not_allowed']),
      )
      expect(await rowsWhere(s, 'variant_id = ?', [p.variantId])).toEqual([])
      expect(tried.flatMap((t) => mailsTo(s, t.email))).toEqual([])
    })

    it('AC-2: an unknown variant answers 404 alerts.variant_not_found, with no row and no mail', async () => {
      const ghost = randomUUID()
      const a = freshEmail('ac2-ghost')

      const unknown = await subscribe(s, a, ghost)
      await delivered(s)

      expect([unknown.status, said(unknown)]).toEqual([404, 'alerts.variant_not_found'])
      expect(await rowsWhere(s, 'variant_id = ?', [ghost])).toEqual([])
      expect(mailsTo(s, a)).toEqual([])
    })

    it('AC-2: an address of 255 characters or more answers 400 with no row and no mail, and one of 254 is accepted', async () => {
      const p = await seedProduct(s.k, 0)
      const longest = freshEmailOfLength('ac2-long', 254)
      const over = [freshEmailOfLength('ac2-long', 255), freshEmailOfLength('ac2-long', 3000)]
      expect([longest, ...over].map((email) => email.length)).toEqual([254, 255, 3000])

      const refused: Answer[] = []
      for (const email of over) refused.push(await subscribe(s, email, p.variantId))
      const accepted = await subscribe(s, longest, p.variantId)
      await delivered(s)

      expect(
        refused.map((a) => a.status),
        refused.map((a) => a.text.slice(0, 200)).join('\n'),
      ).toEqual([400, 400])
      expect(accepted.status, accepted.text.slice(0, 300)).toBe(202)
      expect((await rowsWhere(s, 'variant_id = ?', [p.variantId])).map((r) => r.email)).toEqual([
        longest,
      ])
      expect(over.flatMap((email) => mailsTo(s, email))).toEqual([])
    })

    it('AC-4: property: whether the address is a registered customer’s, unregistered, or has an active, pending or unsubscribed subscription, or differs only in case and spaces, subscribe answers the same status, body bytes and headers, and writes the row’s updated_at', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
          arbForm,
          async (local, form) => {
            const p = await seedProduct(s.k, 0)
            const tag = randomUUID().slice(0, 8)
            const addr = (role: string): string => `${local}.${role}.${tag}@alerts.test`
            const registered = addr('registered')
            await s.k.services.auth.register({
              email: registered,
              password: 'correct-horse-battery',
            })
            const active = addr('active')
            await activate(s, active, p.variantId)
            const pending = addr('pending')
            await subscribed(s, pending, p.variantId)
            const left = addr('unsubscribed')
            await subscribed(s, left, p.variantId)
            await delivered(s)
            const out = await unsubscribe(s, latestConfirmation(s, left).unsubscribe)
            expect(out.status, out.text).toBe(200)

            const backdated = new Map<string, number>()
            for (const email of [active, pending, left]) {
              backdated.set(email, await backdate(s, await rowOf(s, email, p.variantId)))
            }

            const cases: Array<[string, string]> = [
              ['registered', registered],
              ['registered, case and spaces', vary(registered, form)],
              ['unregistered', addr('unregistered')],
              ['active', active],
              ['active, case and spaces', vary(active, form)],
              ['pending', pending],
              ['unsubscribed', left],
            ]
            const answers: Array<{ label: string; answer: Answer }> = []
            for (const [label, email] of cases) {
              answers.push({ label, answer: await subscribe(s, email, p.variantId) })
            }
            await delivered(s)

            const shape = (a: Answer) => ({
              status: a.status,
              text: a.text,
              headers: Object.fromEntries(
                [...a.headers.entries()].filter(
                  ([name]) =>
                    !['date', 'x-request-id', 'x-correlation-id'].includes(name) &&
                    !/rate-?limit/i.test(name),
                ),
              ),
            })
            expect(answers[0]!.answer.status, answers[0]!.answer.text.slice(0, 300)).toBe(202)
            for (const { label, answer } of answers) {
              expect(shape(answer), label).toEqual(shape(answers[0]!.answer))
            }
            for (const [email, old] of backdated) {
              const row = await rowOf(s, email, p.variantId)
              expect(instant(row.updated_at), `${email}: updated_at`).toBeGreaterThan(old)
            }
            expect((await rowOf(s, active, p.variantId)).status).toBe('active')
          },
        ),
        { numRuns: options.propertyRuns },
      )
    }, 300_000)

    it('AC-5: property: over random sequences of subscribes (in case and space variants), k concurrent identical subscribes, confirms, unsubscribes and restock cycles, there is at most one row per address, variant and kind; an active row gets no mail from a repeat, and each accepted repeat on a pending, unsubscribed or fired row leaves it pending and sends one confirmation', async () => {
      const arbBurst = fc.record({
        kind: fc.constant('burst' as const),
        who: arbWho,
        k: fc.integer({ min: 2, max: 5 }),
      })
      const arbCycle = fc.constant([
        { kind: 'restock' as const, delta: 1 },
        { kind: 'sellout' as const },
      ])
      const arbOps = fc
        .array(
          fc.oneof(
            arbSubscribe.map((op) => [op]),
            arbBurst.map((op) => [op]),
            arbConfirm.map((op) => [op]),
            arbUnsubscribe.map((op) => [op]),
            arbCycle,
          ),
          { minLength: 1, maxLength: 8 },
        )
        .map((groups) => groups.flat() as Op[])
      await fc.assert(
        fc.asyncProperty(arbOps, async (ops) => {
          const m = new Machine(s, await seedProduct(s.k, 0))
          for (const op of ops) {
            await m.apply(op)
            const label = JSON.stringify(op)
            expect(await duplicates(s), label).toEqual([])
            const rows = await rowsWhere(s, 'variant_id = ?', [m.product.variantId])
            expect(Object.fromEntries(rows.map((r) => [r.email, r.status])), label).toEqual(
              Object.fromEntries(
                m.people.filter((p) => p.state !== 'none').map((p) => [p.email, p.state]),
              ),
            )
            expect(
              m.people.map((p) => mailsTo(s, p.email, CONFIRM_MAIL).length),
              `${label}: confirmations`,
            ).toEqual(m.people.map((p) => p.confirmations))
          }
        }),
        {
          numRuns: options.propertyRuns,
          examples: [
            [
              [
                { kind: 'subscribe', who: 0, form: null, origin: 0 },
                { kind: 'burst', who: 0, k: 3 },
                { kind: 'confirm', who: 0 },
                { kind: 'burst', who: 0, k: 3 },
                { kind: 'restock', delta: 1 },
                { kind: 'sellout' },
                {
                  kind: 'subscribe',
                  who: 0,
                  form: { left: 2, right: 1, pattern: 'upper' },
                  origin: 1,
                },
                { kind: 'unsubscribe', who: 0 },
                { kind: 'burst', who: 0, k: 2 },
              ],
            ],
          ],
        },
      )
    }, 300_000)
  })

  describe(`alerts: back in stock, once, row by row (${dialect})`, () => {
    let s: Store
    const twice = { on: true }

    beforeAll(async () => {
      s = await openStore(options, { retry: true })
      // At-least-once: while `twice.on`, the bus hands every event to the subscribers twice.
      const bus = s.k.eventBus
      const publish = bus.publish.bind(bus)
      bus.publish = async function <T>(event: NymbalEvent<T>): Promise<void> {
        await publish(event)
        if (twice.on) await publish(event)
      }
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    it('AC-6: property: with every event delivered twice, over random restocks, sell-outs and subscription states, the alerts sent equal the model: one per activation at the first restock, none to a pending, unsubscribed or fired row, each with the product link and the row’s unsubscribe link at its origin and one alert.sent.v1', async () => {
      twice.on = true
      const arbOps = fc.array(
        fc.oneof(arbSubscribe, arbConfirm, arbUnsubscribe, arbRestock, arbSellout),
        { minLength: 1, maxLength: 12 },
      ) as fc.Arbitrary<Op[]>
      await fc.assert(
        fc.asyncProperty(arbOps, async (ops) => {
          const m = new Machine(s, await seedProduct(s.k, 0))
          for (const op of ops) {
            await m.apply(op)
            const label = JSON.stringify(op)

            expect(
              m.people.map((p) =>
                mailsTo(s, p.email, ALERT_MAIL).map(
                  (mail) => link(mail.vars['productUrl'], `/product/${m.product.slug}`).origin,
                ),
              ),
              `${label}: alerts and their origins`,
            ).toEqual(m.people.map((p) => p.alerts))
            expect(
              m.people.flatMap((p) =>
                mailsTo(s, p.email).filter(
                  (mail) => ![CONFIRM_MAIL, ALERT_MAIL].includes(mail.template),
                ),
              ),
              label,
            ).toEqual([])

            const rows = await rowsWhere(s, 'variant_id = ?', [m.product.variantId])
            const restocks = (await eventRows(s.raw, 'type = ?', ['product.restocked.v1']))
              .filter(
                (e) =>
                  (e.envelope.payload as { variantId: string }).variantId === m.product.variantId,
              )
              .map((e) => e.id)
            const sent = (await eventRows(s.raw, 'type = ?', ['alert.sent.v1'])).map(
              (e) =>
                e.envelope.payload as {
                  subscriptionId: string
                  kind: string
                  triggerEventId: string
                },
            )
            for (const p of m.people) {
              const row = rows.find((r) => r.email === p.email)
              const alerts = mailsTo(s, p.email, ALERT_MAIL)
              for (const mail of alerts) {
                expect(link(mail.vars['unsubscribeUrl'], '/alerts/unsubscribe'), label).toEqual({
                  origin: link(mail.vars['productUrl'], `/product/${m.product.slug}`).origin,
                  token: row?.unsubscribe_token,
                })
              }
              const own = sent.filter((e) => e.subscriptionId === row?.id)
              expect(own.length, `${label}: alert.sent.v1 for ${p.email}`).toBe(alerts.length)
              for (const e of own) {
                expect(e.kind).toBe(KIND)
                expect(restocks, label).toContain(e.triggerEventId)
              }
            }
          }
        }),
        {
          numRuns: options.propertyRuns,
          examples: [
            [
              [
                { kind: 'subscribe', who: 0, form: null, origin: 1 },
                { kind: 'subscribe', who: 1, form: null, origin: 0 },
                { kind: 'confirm', who: 0 },
                { kind: 'restock', delta: 2 },
                { kind: 'sellout' },
                { kind: 'restock', delta: 1 },
                { kind: 'subscribe', who: 0, form: null, origin: 0 },
                { kind: 'confirm', who: 0 },
                { kind: 'sellout' },
                { kind: 'restock', delta: 1 },
              ],
            ],
          ],
        },
      )
    }, 300_000)

    it('AC-8: when the adapter refuses one address once, the first delivery mails and fires the other two active rows and leaves the restock undelivered with attempts 1; the retry mails the refused row once and the others nothing more, delivers the restock, and each row has one alert.sent.v1 for it', async () => {
      twice.on = false
      const p = await seedProduct(s.k, 0)
      const emails = ['ac8-a', 'ac8-bad', 'ac8-c'].map(freshEmail)
      const bad = emails[1]!
      for (const email of emails) await activate(s, email, p.variantId)
      const rowIds = await Promise.all(emails.map(async (e) => (await rowOf(s, e, p.variantId)).id))
      const tried = (email: string) =>
        s.mail.attempts.filter((m) => m.to === norm(email) && m.template === ALERT_MAIL).length
      const alerted = () => emails.map((e) => mailsTo(s, e, ALERT_MAIL).length)
      const statuses = () =>
        Promise.all(emails.map(async (e) => (await rowOf(s, e, p.variantId)).status))
      s.mail.refuse.set(norm(bad), 1)
      const before = await lastSeq(s)

      await restock(s, p.variantId, 1)
      await settled(s)

      const event = await triggerOf(s, 'product.restocked.v1', p.variantId, before)
      expect(alerted(), 'alerts after the first delivery').toEqual([1, 0, 1])
      expect(await statuses()).toEqual(['fired', 'active', 'fired'])
      expect(await deliveryOf(s, event.id), 'the restock after the first delivery').toEqual([
        1,
        false,
        false,
      ])

      await retried(s)

      expect(alerted(), 'alerts after the retry').toEqual([1, 1, 1])
      expect(tried(bad)).toBe(2)
      expect(await statuses()).toEqual(['fired', 'fired', 'fired'])
      expect(await deliveryOf(s, event.id), 'the restock after the retry').toEqual([1, true, false])
      expect(await sentPerRow(s, rowIds, event.id)).toEqual(alerted())
    })

    it('AC-8: when every attempted row is refused once, the first delivery mails nothing and leaves both rows active and the restock undelivered with attempts 1; the retry mails each row once, fires both and delivers the restock', async () => {
      twice.on = false
      const p = await seedProduct(s.k, 0)
      const emails = ['ac8-x', 'ac8-y'].map(freshEmail)
      for (const email of emails) await activate(s, email, p.variantId)
      for (const email of emails) s.mail.refuse.set(norm(email), 1)
      const alerted = () => emails.map((e) => mailsTo(s, e, ALERT_MAIL).length)
      const statuses = () =>
        Promise.all(emails.map(async (e) => (await rowOf(s, e, p.variantId)).status))
      const before = await lastSeq(s)

      await restock(s, p.variantId, 1)
      await settled(s)

      const event = await triggerOf(s, 'product.restocked.v1', p.variantId, before)
      expect(alerted()).toEqual([0, 0])
      expect(await statuses()).toEqual(['active', 'active'])
      expect(await deliveryOf(s, event.id)).toEqual([1, false, false])

      await retried(s)

      expect(alerted()).toEqual([1, 1])
      expect(await statuses()).toEqual(['fired', 'fired'])
      expect(await deliveryOf(s, event.id)).toEqual([1, true, false])
    })

    it(`AC-8: when the adapter refuses one address on every attempt, the other two are mailed once; the refused row is tried ${MAX_ATTEMPTS} times (maxAttempts) and stays active, the restock is dead and is tried no more; once the refusals end, the next restock mails that row once and the others nothing`, async () => {
      twice.on = false
      const p = await seedProduct(s.k, 0)
      const emails = ['ac8-p', 'ac8-refused', 'ac8-q'].map(freshEmail)
      const bad = emails[1]!
      for (const email of emails) await activate(s, email, p.variantId)
      s.mail.refuse.set(norm(bad), Number.POSITIVE_INFINITY)
      const tried = (email: string) =>
        s.mail.attempts.filter((m) => m.to === norm(email) && m.template === ALERT_MAIL).length
      const alerted = () => emails.map((e) => mailsTo(s, e, ALERT_MAIL).length)
      const before = await lastSeq(s)

      await restock(s, p.variantId, 1)
      await settled(s)
      const event = await triggerOf(s, 'product.restocked.v1', p.variantId, before)
      for (let attempt = 2; attempt <= MAX_ATTEMPTS + 2; attempt += 1) await retried(s)

      expect(tried(bad), 'sends to the refused address').toBe(MAX_ATTEMPTS)
      expect(alerted()).toEqual([1, 0, 1])
      expect((await rowOf(s, bad, p.variantId)).status).toBe('active')
      expect(await deliveryOf(s, event.id)).toEqual([MAX_ATTEMPTS, false, true])

      // Sold out and back again once the refusals have ended.
      s.mail.refuse.delete(norm(bad))
      await restock(s, p.variantId, -1)
      await restock(s, p.variantId, 1)
      await settled(s)

      expect(alerted()).toEqual([1, 1, 1])
      expect(tried(bad)).toBe(MAX_ATTEMPTS + 1)
      expect((await rowOf(s, bad, p.variantId)).status).toBe('fired')
    })

    it('AC-8: a confirmation the adapter refuses once is not sent by the first delivery, which leaves alert.requested.v1 undelivered with attempts 1, and is sent once by the retry, which delivers the event', async () => {
      twice.on = false
      const p = await seedProduct(s.k, 0)
      const email = freshEmail('ac8-confirm')
      s.mail.refuse.set(norm(email), 1)
      const before = await lastSeq(s)

      await subscribed(s, email, p.variantId)
      await settled(s)

      const [requested] = await eventRows(s.raw, 'seq > ? AND type = ?', [
        before,
        'alert.requested.v1',
      ])
      expect(mailsTo(s, email, CONFIRM_MAIL).length, 'confirmations after the refusal').toBe(0)
      expect(await deliveryOf(s, requested!.id)).toEqual([1, false, false])

      await retried(s)
      await retried(s)

      expect(mailsTo(s, email, CONFIRM_MAIL).length, 'confirmations after the retry').toBe(1)
      expect(await deliveryOf(s, requested!.id)).toEqual([1, true, false])
    })
  })

  describe(`alerts: price-drop subscriptions and their baseline (${dialect})`, () => {
    let s: Store

    beforeAll(async () => {
      s = await openStore(options)
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    it('AC-3: a price_drop subscribe answers 202 pending and writes one pending price_drop row whose baseline is the variant’s price at that moment', async () => {
      const p = await seedProduct(s.k, 4)
      await reprice(s, p, 1300)
      const email = freshEmail('ac3')

      const res = await subscribe(s, email, p.variantId, SHOP_A, PRICE_DROP)
      expect(res.status, res.text.slice(0, 300)).toBe(202)
      expect(res.body).toEqual({ data: { status: 'pending' } })
      await delivered(s)

      const served = (await s.k.services.product.getById(p.productId)).variants[0]!.priceMinor
      const row = await rowOf(s, email, p.variantId, PRICE_DROP)
      expect({ kind: row.kind, status: row.status, baseline: baselineOf(row) }).toEqual({
        kind: PRICE_DROP,
        status: 'pending',
        baseline: served,
      })
    })

    it('AC-3: a repeat subscribe on a pending or an active row leaves its baseline; after a price change and an unsubscribe, a resubscribe resets it to the price at that moment', async () => {
      const p = await seedProduct(s.k, 4)
      const email = freshEmail('ac3-again')
      const at = async () => baselineOf(await rowOf(s, email, p.variantId, PRICE_DROP))

      await subscribed(s, email, p.variantId, SHOP_A, PRICE_DROP)
      await delivered(s)
      const first = await at()
      expect(first, 'the baseline at the first subscribe').toBe(1500)

      await reprice(s, p, 1200)
      await subscribed(s, email, p.variantId, SHOP_B, PRICE_DROP)
      await delivered(s)
      const pendingRepeat = await at()

      const tokens = latestConfirmation(s, email, PRICE_CONFIRM_MAIL)
      expect((await confirm(s, tokens.confirm)).status).toBe(200)
      await reprice(s, p, 1700)
      await subscribed(s, email, p.variantId, SHOP_A, PRICE_DROP)
      await delivered(s)
      const activeRepeat = await at()

      expect((await unsubscribe(s, tokens.unsubscribe)).status).toBe(200)
      await reprice(s, p, 1350)
      await subscribed(s, email, p.variantId, SHOP_A, PRICE_DROP)
      await delivered(s)
      const row = await rowOf(s, email, p.variantId, PRICE_DROP)

      expect([pendingRepeat, activeRepeat], 'repeats on a pending and an active row').toEqual([
        first,
        first,
      ])
      const now = (await s.k.services.product.getById(p.productId)).variants[0]!.priceMinor
      expect(now, 'the price the resubscribe saw').toBe(1350)
      expect([row.status, baselineOf(row)], 'the resubscribe').toEqual(['pending', now])
    })

    it('AC-3: a back_in_stock and a price_drop subscribe for one address and variant are two rows, the back_in_stock one with no baseline, and confirming one leaves the other pending', async () => {
      const p = await seedProduct(s.k, 0)
      const email = freshEmail('ac3-both')

      await subscribed(s, email, p.variantId, SHOP_A, KIND)
      await subscribed(s, email, p.variantId, SHOP_A, PRICE_DROP)
      await delivered(s)
      const res = await confirm(s, latestConfirmation(s, email, PRICE_CONFIRM_MAIL).confirm)
      expect(res.status, res.text.slice(0, 300)).toBe(200)

      const rows = await rowsWhere(s, 'email = ? AND variant_id = ?', [norm(email), p.variantId])
      expect(
        rows
          .map((r) => [r.kind, r.status, baselineOf(r)])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      ).toEqual([
        [KIND, 'pending', null],
        [PRICE_DROP, 'active', 1500],
      ])
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
    })

    it('AC-4: a price_drop subscribe sends one alert-confirm-price-drop and no alert-confirm, with the row’s links, whose subject and text name the price drop and never back in stock; a back_in_stock subscribe still sends alert-confirm', async () => {
      const p = await seedProduct(s.k, 4)
      const watcher = freshEmail('ac4-confirm')
      const waiter = freshEmail('ac4-restock')

      await subscribed(s, watcher, p.variantId, SHOP_B, PRICE_DROP)
      await subscribed(s, waiter, p.variantId, SHOP_A, KIND)
      await delivered(s)

      expect(mailsTo(s, watcher).map((m) => m.template)).toEqual([PRICE_CONFIRM_MAIL])
      expect(mailsTo(s, waiter).map((m) => m.template)).toEqual([CONFIRM_MAIL])

      const row = await rowOf(s, watcher, p.variantId, PRICE_DROP)
      const vars = mailsTo(s, watcher)[0]!.vars
      expect(link(vars['confirmUrl'], '/alerts/confirm')).toEqual({
        origin: SHOP_B,
        token: row.confirm_token,
      })
      expect(link(vars['unsubscribeUrl'], '/alerts/unsubscribe')).toEqual({
        origin: SHOP_B,
        token: row.unsubscribe_token,
      })
      expect(link(vars['productUrl'], `/product/${p.slug}`).origin).toBe(SHOP_B)
      expect(vars['productName']).toBe(p.name)

      const rendered = renderEmailTemplate(PRICE_CONFIRM_MAIL, vars)
      expect(rendered.subject).toBe(`Confirm your price alert for ${p.name}`)
      expect(rendered.text).toContain(`the price of ${p.name} drops`)
      expect(rendered.text).toContain(String(vars['confirmUrl']))
      expect(rendered.text).toContain(String(vars['unsubscribeUrl']))
      expect(`${rendered.subject}\n${rendered.text}`).not.toMatch(/back in stock/i)
    })
  })

  describe(`alerts: price drops, by the baseline rule, row by row (${dialect})`, () => {
    let s: Store
    const twice = { on: true }

    beforeAll(async () => {
      s = await openStore(options, { currency: PRICE_CURRENCY, retry: true })
      // At-least-once: while `twice.on`, the bus hands every event to the subscribers twice.
      const bus = s.k.eventBus
      const publish = bus.publish.bind(bus)
      bus.publish = async function <T>(event: NymbalEvent<T>): Promise<void> {
        await publish(event)
        if (twice.on) await publish(event)
      }
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    it('AC-4: property: with every event delivered twice, over random price rises, drops and equal saves and subscription states, the price alerts sent equal the model: an active row is mailed exactly when the new price is below the previous one and its baseline, which then moves to the new price, and it stays active; pending and unsubscribed rows get nothing; each alert names both prices in the store currency, links the product and the row’s unsubscribe link at its origin, never says back in stock or one-time, and has one alert.sent.v1', async () => {
      twice.on = true
      const arbOps = fc.array(
        fc.oneof(
          { arbitrary: arbPriceSubscribe, weight: 2 },
          { arbitrary: arbConfirm, weight: 2 },
          { arbitrary: arbUnsubscribe, weight: 1 },
          { arbitrary: arbPrice, weight: 4 },
        ),
        { minLength: 1, maxLength: 12 },
      ) as fc.Arbitrary<PriceOp[]>
      await fc.assert(
        fc.asyncProperty(arbOps, async (ops) => {
          const product = await seedProduct(s.k, 4)
          const m = new PriceMachine(s, product, 1500)
          for (const op of ops) {
            await m.apply(op)
            const label = JSON.stringify(op)

            const rows = await rowsWhere(s, 'variant_id = ? AND kind = ?', [
              product.variantId,
              PRICE_DROP,
            ])
            expect(
              Object.fromEntries(rows.map((r) => [r.email, [r.status, baselineOf(r)]])),
              `${label}: statuses and baselines`,
            ).toEqual(
              Object.fromEntries(
                m.people
                  .filter((p) => p.state !== 'none')
                  .map((p) => [p.email, [p.state, p.baseline]]),
              ),
            )
            expect(
              m.people.map((p) => mailsTo(s, p.email, PRICE_CONFIRM_MAIL).length),
              `${label}: confirmations`,
            ).toEqual(m.people.map((p) => p.confirmations))
            expect(
              m.people.flatMap((p) =>
                mailsTo(s, p.email)
                  .filter((mail) => ![PRICE_CONFIRM_MAIL, PRICE_ALERT_MAIL].includes(mail.template))
                  .map((mail) => mail.template),
              ),
              `${label}: other mail`,
            ).toEqual([])
            expect(
              m.people.map((p) =>
                mailsTo(s, p.email, PRICE_ALERT_MAIL).map((mail) => [
                  mail.vars['previousPriceFormatted'],
                  mail.vars['priceFormatted'],
                  link(mail.vars['productUrl'], `/product/${product.slug}`).origin,
                ]),
              ),
              `${label}: alerts`,
            ).toEqual(
              m.people.map((p) =>
                p.alerts.map((a) => [
                  money(a.previous, PRICE_CURRENCY),
                  money(a.price, PRICE_CURRENCY),
                  a.origin,
                ]),
              ),
            )

            const triggers = await priceEventIds(s, product.variantId)
            const sent = (await eventRows(s.raw, 'type = ?', ['alert.sent.v1'])).map(
              (e) =>
                e.envelope.payload as {
                  subscriptionId: string
                  kind: string
                  triggerEventId: string
                },
            )
            for (const p of m.people) {
              const row = rows.find((r) => r.email === p.email)
              const alerts = mailsTo(s, p.email, PRICE_ALERT_MAIL)
              for (const mail of alerts) {
                expect(link(mail.vars['unsubscribeUrl'], '/alerts/unsubscribe'), label).toEqual({
                  origin: link(mail.vars['productUrl'], `/product/${product.slug}`).origin,
                  token: row?.unsubscribe_token,
                })
                const rendered = renderEmailTemplate(PRICE_ALERT_MAIL, mail.vars)
                const copy = `${rendered.subject}\n${rendered.text}`
                for (const part of [
                  mail.vars['previousPriceFormatted'],
                  mail.vars['priceFormatted'],
                  mail.vars['productUrl'],
                  mail.vars['unsubscribeUrl'],
                ]) {
                  expect(copy, `${label}: the alert's copy`).toContain(String(part))
                }
                expect(copy, label).not.toMatch(/back in stock|one-time/i)
              }
              const own = sent.filter((e) => e.subscriptionId === row?.id)
              expect(own.length, `${label}: alert.sent.v1 for ${p.email}`).toBe(alerts.length)
              for (const e of own) {
                expect(e.kind).toBe(PRICE_DROP)
                expect(triggers, label).toContain(e.triggerEventId)
              }
            }
          }
        }),
        {
          numRuns: options.propertyRuns,
          examples: [
            [
              [
                { kind: 'subscribe', who: 0, origin: 1 },
                { kind: 'confirm', who: 0 },
                { kind: 'price', move: 'down', step: 300 },
                { kind: 'price', move: 'up', step: 300 },
                { kind: 'price', move: 'down', step: 300 },
                { kind: 'price', move: 'down', step: 100 },
                { kind: 'subscribe', who: 1, origin: 0 },
                { kind: 'price', move: 'down', step: 100 },
                { kind: 'confirm', who: 1 },
                { kind: 'price', move: 'equal', step: 1 },
                { kind: 'unsubscribe', who: 0 },
                { kind: 'price', move: 'down', step: 100 },
                { kind: 'subscribe', who: 0, origin: 0 },
                { kind: 'confirm', who: 0 },
                { kind: 'price', move: 'down', step: 50 },
              ],
            ],
          ],
        },
      )
    }, 300_000)

    it('AC-4: the price event carries the store currency, and each alert formats both prices from minor units in it', async () => {
      twice.on = false
      const p = await seedProduct(s.k, 4)
      const email = freshEmail('ac4-currency')
      await activatePriceDrop(s, email, p.variantId)

      await reprice(s, p, 1234)
      await delivered(s)

      const [event] = (await eventRows(s.raw, 'type = ?', [PRICE_CHANGED])).filter(
        (e) => (e.envelope.payload as { variantId?: string }).variantId === p.variantId,
      )
      expect(event?.envelope.payload).toMatchObject({
        previousPriceMinor: 1500,
        priceMinor: 1234,
        currency: s.k.config.store.currency,
      })
      expect(
        mailsTo(s, email, PRICE_ALERT_MAIL).map((m) => [
          m.vars['previousPriceFormatted'],
          m.vars['priceFormatted'],
        ]),
      ).toEqual([[money(1500, s.k.config.store.currency), money(1234, s.k.config.store.currency)]])
    })

    it('AC-8: when the adapter refuses one address once, the first price drop mails the other two and moves their baselines, leaves the refused row active at its baseline and the price event undelivered with attempts 1; the retry mails the refused row once and the others nothing more, moves its baseline, delivers the event, and each row has one alert.sent.v1 for it', async () => {
      twice.on = false
      const p = await seedProduct(s.k, 4)
      const emails = ['ac8-pa', 'ac8-pbad', 'ac8-pc'].map(freshEmail)
      const bad = emails[1]!
      for (const email of emails) await activatePriceDrop(s, email, p.variantId)
      const rowIds = await Promise.all(
        emails.map(async (e) => (await rowOf(s, e, p.variantId, PRICE_DROP)).id),
      )
      const tried = (email: string) =>
        s.mail.attempts.filter((m) => m.to === norm(email) && m.template === PRICE_ALERT_MAIL)
          .length
      const alerted = () => emails.map((e) => mailsTo(s, e, PRICE_ALERT_MAIL).length)
      const state = () =>
        Promise.all(
          emails.map(async (e) => {
            const row = await rowOf(s, e, p.variantId, PRICE_DROP)
            return [row.status, baselineOf(row)]
          }),
        )
      s.mail.refuse.set(norm(bad), 1)
      const before = await lastSeq(s)

      await reprice(s, p, 1200)
      await settled(s)

      const event = await triggerOf(s, PRICE_CHANGED, p.variantId, before)
      expect(alerted(), 'alerts after the first delivery').toEqual([1, 0, 1])
      expect(await state()).toEqual([
        ['active', 1200],
        ['active', 1500],
        ['active', 1200],
      ])
      expect(await deliveryOf(s, event.id)).toEqual([1, false, false])

      await retried(s)

      expect(alerted(), 'alerts after the retry').toEqual([1, 1, 1])
      expect(tried(bad)).toBe(2)
      expect(await state()).toEqual([
        ['active', 1200],
        ['active', 1200],
        ['active', 1200],
      ])
      expect(await deliveryOf(s, event.id)).toEqual([1, true, false])
      expect(await sentPerRow(s, rowIds, event.id)).toEqual(alerted())
    })

    it(`AC-8: when the adapter refuses one address on every attempt, the other active rows are mailed once and their baselines move; the refused row is tried ${MAX_ATTEMPTS} times (maxAttempts) and stays active with its baseline unmoved, the price event is dead before the refusals end, and the next drop below its baseline mails it alone`, async () => {
      twice.on = false
      const p = await seedProduct(s.k, 4)
      const a = freshEmail('ac8-pd-a')
      const bad = freshEmail('ac8-pd-bad')
      const c = freshEmail('ac8-pd-c')
      for (const email of [a, bad, c]) await activatePriceDrop(s, email, p.variantId)
      s.mail.refuse.set(norm(bad), Number.POSITIVE_INFINITY)
      const before = await lastSeq(s)

      await reprice(s, p, 1200)
      await settled(s)
      const event = await triggerOf(s, PRICE_CHANGED, p.variantId, before)
      for (let attempt = 2; attempt <= MAX_ATTEMPTS + 2; attempt += 1) await retried(s)

      const tried = (email: string) =>
        s.mail.attempts.filter((m) => m.to === norm(email) && m.template === PRICE_ALERT_MAIL)
          .length
      const alerted = () => [a, bad, c].map((e) => mailsTo(s, e, PRICE_ALERT_MAIL).length)
      const state = () =>
        Promise.all(
          [a, bad, c].map(async (e) => {
            const row = await rowOf(s, e, p.variantId, PRICE_DROP)
            return [row.status, baselineOf(row)]
          }),
        )
      expect(alerted()).toEqual([1, 0, 1])
      expect(tried(bad), 'sends to the refused address').toBe(MAX_ATTEMPTS)
      expect(await state()).toEqual([
        ['active', 1200],
        ['active', 1500],
        ['active', 1200],
      ])
      expect(await deliveryOf(s, event.id)).toEqual([MAX_ATTEMPTS, false, true])

      // The refusals end; a rise, then a drop below the refused row's baseline but not the others'.
      s.mail.refuse.delete(norm(bad))
      await reprice(s, p, 1400)
      await settled(s)
      await reprice(s, p, 1300)
      await settled(s)

      expect(alerted()).toEqual([1, 1, 1])
      expect(await state()).toEqual([
        ['active', 1200],
        ['active', 1300],
        ['active', 1200],
      ])
    })
  })

  describe(`alerts: stores that cannot take a subscription (${dialect})`, () => {
    it('AC-2: a store whose only allowed origin is * answers 400 alerts.origin_not_allowed, with no row and no mail', async () => {
      const star = await openStore(options, { origins: ['*'] })
      try {
        const p = await seedProduct(star.k, 0)
        const email = freshEmail('ac2-star')
        const answers = [
          await subscribe(star, email, p.variantId, SHOP_A),
          await subscribe(star, email, p.variantId, 'http://anywhere.test'),
        ]
        await delivered(star)
        expect(answers.map((a) => [a.status, said(a)])).toEqual(
          answers.map(() => [400, 'alerts.origin_not_allowed']),
        )
        expect(await rowsWhere(star, 'variant_id = ?', [p.variantId])).toEqual([])
        expect(mailsTo(star, email)).toEqual([])
      } finally {
        await star.close()
      }
    }, 60_000)

    it('AC-2: a native email store answers 409 alerts.unavailable, with no row and no alert event', async () => {
      const native = await openStore(options, { email: 'native' })
      try {
        const p = await seedProduct(native.k, 0)
        const res = await subscribe(native, freshEmail('ac2-native'), p.variantId, SHOP_A)
        await delivered(native)
        expect([res.status, said(res)]).toEqual([409, 'alerts.unavailable'])
        expect(await native.raw.count(TABLE)).toBe(0)
        expect(await native.raw.count('events', "type LIKE 'alert.%'")).toBe(0)
      } finally {
        await native.close()
      }
    }, 60_000)
  })

  describe(`alerts: the migration (${dialect})`, () => {
    it('AC-2: the alerts migration applies on top of the schema before it with existing rows, keeps every row, and gives the table its columns, unique keys and fan-out index', async () => {
      const target = await options.fresh()
      const before = migrationsBeforeAlerts(dialect)
      const raw = openRaw(dialect, target)
      try {
        await migrate(dialect, target, before.root)
        await seedAt(dialect, target)
        const kept = await tableCounts(raw, dialect)
        expect(Object.keys(kept)).not.toContain(TABLE)

        await migrate(dialect, target, MIGRATIONS_ROOT)

        const after = await tableCounts(raw, dialect)
        expect(Object.fromEntries(Object.entries(after).filter(([t]) => t !== TABLE))).toEqual(kept)
        expect(after[TABLE]).toBe(0)
        expect(await columnsOf(raw, dialect)).toEqual(
          [
            'id',
            'email',
            'kind',
            'variant_id',
            'product_id',
            'status',
            'confirm_token',
            'unsubscribe_token',
            'origin',
            'baseline_price_minor',
            'created_at',
            'updated_at',
            'confirmed_at',
          ].sort(),
        )
        expect(sortedIndexes(await indexesOf(raw, dialect))).toEqual(
          [
            'unique (email, variant_id, kind)',
            'unique (confirm_token)',
            'unique (unsubscribe_token)',
            '(variant_id, kind, status)',
          ].sort(),
        )
      } finally {
        await raw.close()
        before.drop()
      }
    }, 60_000)
  })
}
