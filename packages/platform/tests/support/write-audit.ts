import { AsyncLocalStorage } from 'node:async_hooks'
import { expect } from 'vitest'
import { STANDARD_EVENT_TYPES } from '@nymbalhq/types'
import {
  beforeCommit,
  openTransaction,
  rawClients,
  type CommandStore,
} from '../../src/db/command-store.js'

// Every committed outermost transaction on an audited SQLite store, checked before its COMMIT: one that changes a
// domain table inserts at least one `events` row, and one that inserts an `events` row changes a domain table unless
// every event it inserts is notification-only. Row changes are counted by TEMP triggers on the store's own connection,
// so they see exactly that connection's writes; the counts are cleared on each outermost entry (inside the
// transaction), so rows seeded beforehand through `rawClients(store).raw` never reach a check, and a savepoint that
// rolls back takes its counts with it. A violation is recorded, never thrown: the transaction commits as it would have,
// and the test file's afterEach (write-audit.setup.ts) fails on what was recorded.

/** Tables a transaction may change without an event, each because no projection or handler reads it for a read model. */
export const EXEMPT_TABLES: Readonly<Record<string, string>> = {
  events: 'the event log itself; its updates are the relay bookkeeping',
  processed_events: "a handler's record of the events it has handled",
  refresh_tokens: 'a credential; no read model is built from it',
  order_sequences: 'the order-number counter; no read model is built from it',
  audit_entries: 'the audit trail, written beside the command it records',
  order_access_keys: 'a credential checkout mints in its own write after placement settles',
  email_suppressions:
    'written inside a delivery by the email feedback and alert handlers, not by a command',
  order_refunds:
    'read from its own table, no read model; a refund that moves money changes the order and publishes its events',
}

/** Kernel event types a transaction may insert with no domain change, each because the event is all there is to write. */
export const NOTIFICATION_ONLY: Readonly<Record<string, string>> = {
  'product.viewed.v1':
    'a view is recorded as its event alone; recently viewed is built from the log',
  'visitor.merged.v1': "a sign-in's fold of a visitor's views, recorded as its event alone",
  'order.confirmation_resend_requested.v1':
    'asks the email handler to send the confirmation again; nothing about the order changes',
  'payment.failed.v1':
    "a payment provider's report, recorded as it arrives; its handler changes the order in its own delivery",
}

const KERNEL_TYPES: ReadonlySet<string> = new Set(STANDARD_EVENT_TYPES)

/**
 * An event type the kernel does not declare is an adapter's (a provider webhook's bounce, complaint or tracking
 * update): the inbound route records it as it arrives, and the handler that acts on it writes in its own delivery.
 */
function notificationOnly(type: string): boolean {
  return type in NOTIFICATION_ONLY || !KERNEL_TYPES.has(type)
}

export interface WriteAuditViolation {
  rule: 'domain change with no event' | 'event with no domain change'
  /** The test file and the test (or hook) the transaction ran in. */
  file: string
  test: string
  /** Each table the transaction changed, with how many rows by operation. */
  tables: Record<string, Partial<Record<Op, number>>>
  /** The type of each `events` row it inserted, in order. */
  events: string[]
  /** The frames that opened the transaction, nearest first, outside the store and this audit. */
  openedAt: string[]
}

type Op = 'insert' | 'update' | 'delete'
const OPS: readonly Op[] = ['insert', 'update', 'delete']

const CHANGES = 'nymbal_write_audit_changes'
const EVENTS = 'nymbal_write_audit_events'

const found: WriteAuditViolation[] = []
const audited = new WeakSet<CommandStore>()
const unchecked = new AsyncLocalStorage<true>()

/** The violations recorded since the last call, and drains them. */
export function writeAuditViolations(): WriteAuditViolation[] {
  return found.splice(0)
}

/**
 * Runs `fn` with every transaction it opens left out of the audit: for a test's own rows written through a repository
 * (a seeded admin, a row a defect would leave) and the events a test appends itself, never around a service call.
 */
export function unaudited<T>(fn: () => Promise<T>): Promise<T> {
  return unchecked.run(true, fn)
}

/** One line per violation, for an assertion message. */
export function describeViolation(v: WriteAuditViolation): string {
  const tables = Object.entries(v.tables)
    .map(
      ([t, ops]) =>
        `${t}(${Object.entries(ops)
          .map(([op, n]) => `${op} ${n}`)
          .join(', ')})`,
    )
    .join(' ')
  return `${v.rule}: tables ${tables || 'none'}; events [${v.events.join(', ')}]; opened at ${v.openedAt.join(' < ') || '(unknown)'}; in ${v.file} > ${v.test}`
}

const ROOT = new URL('../../../../', import.meta.url).pathname

/** The caller's frames in a stack taken where a transaction was asked for, repository-relative. */
function openers(stack: string | undefined): string[] {
  return (stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => /\(?((?:file:\/\/)?\/[^()]+?:\d+):\d+\)?$/.exec(line.trim())?.[1])
    .filter((frame): frame is string => frame !== undefined)
    .map((frame) => frame.replace(/^file:\/\//, '').replace(ROOT, ''))
    .filter(
      (frame) =>
        !frame.startsWith('/') && !/write-audit\.ts|command-store\.ts|node_modules/.test(frame),
    )
    .slice(0, 3)
}

function where(): { file: string; test: string } {
  try {
    const state = expect.getState()
    return {
      file: state.testPath ?? '(unknown file)',
      test: state.currentTestName ?? '(a hook, outside any test)',
    }
  } catch {
    return { file: '(outside vitest)', test: '(outside vitest)' }
  }
}

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`

/**
 * Installs the audit on a SQLite store from createCommandStore, once; a Postgres store is left alone. Call it after the
 * migrations: tables created later carry no trigger.
 */
export function auditWrites(store: CommandStore): void {
  if (store.kind !== 'sqlite' || audited.has(store)) return
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') return
  const { raw } = clients
  audited.add(store)

  raw.exec(`CREATE TEMP TABLE IF NOT EXISTS ${CHANGES} (tbl TEXT NOT NULL, op TEXT NOT NULL)`)
  raw.exec(`CREATE TEMP TABLE IF NOT EXISTS ${EVENTS} (type TEXT NOT NULL)`)
  const all = raw
    .prepare(
      "SELECT name, sql FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all() as Array<{ name: string; sql: string | null }>
  // A virtual table (the native search index's full-text table) takes no trigger, and its shadow tables are the
  // module's own storage; its content table is a table like any other.
  const virtual = all.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql ?? '')).map((t) => t.name)
  const tables = all.filter((t) => !virtual.some((v) => t.name === v || t.name.startsWith(`${v}_`)))
  for (const { name } of tables) {
    for (const op of OPS) {
      const extra =
        name === 'events' && op === 'insert'
          ? `INSERT INTO ${EVENTS} (type) VALUES (NEW.type);`
          : ''
      raw.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${quoted(`nymbal_write_audit_${name}_${op}`)} ` +
          `AFTER ${op.toUpperCase()} ON main.${quoted(name)} FOR EACH ROW BEGIN ` +
          `INSERT INTO ${CHANGES} (tbl, op) VALUES ('${name.replace(/'/g, "''")}', '${op}'); ${extra} END`,
      )
    }
  }

  const check = (at: { file: string; test: string }, openedAt: string[]): void => {
    const rows = raw
      .prepare(`SELECT tbl, op, count(*) AS n FROM ${CHANGES} GROUP BY tbl, op ORDER BY tbl, op`)
      .all() as Array<{ tbl: string; op: Op; n: number }>
    const events = (
      raw.prepare(`SELECT type FROM ${EVENTS} ORDER BY rowid`).all() as Array<{
        type: string
      }>
    ).map((r) => r.type)
    const changed: WriteAuditViolation['tables'] = {}
    for (const r of rows) (changed[r.tbl] ??= {})[r.op] = Number(r.n)
    const domain = Object.keys(changed).filter((t) => !(t in EXEMPT_TABLES))
    const rule =
      domain.length > 0 && events.length === 0
        ? ('domain change with no event' as const)
        : domain.length === 0 && !events.every(notificationOnly)
          ? ('event with no domain change' as const)
          : undefined
    if (rule !== undefined) found.push({ rule, ...at, tables: changed, events, openedAt })
  }

  const transaction = store.transaction.bind(store)
  const entered = new WeakSet<object>()
  // The store's `savepoint` with no transaction open calls `store.transaction`, so it comes through here as well.
  const audit: CommandStore['transaction'] = (fn) => {
    // Taken before the first await, while the caller is still on the stack.
    const stack = new Error().stack
    return transaction(async (tx) => {
      const scope = openTransaction()
      if (scope !== undefined && !entered.has(scope)) {
        // The outermost entry: this transaction's counts start here, inside it.
        entered.add(scope)
        raw.exec(`DELETE FROM ${CHANGES}; DELETE FROM ${EVENTS};`)
        if (unchecked.getStore() !== true) {
          const at = where()
          const openedAt = openers(stack)
          const last = async () => check(at, openedAt)
          // Held first, it holds the check again so that it runs after the writes held while the callback ran.
          beforeCommit(async () => beforeCommit(last))
        }
      }
      return fn(tx)
    })
  }
  ;(store as { transaction: CommandStore['transaction'] }).transaction = audit
}
