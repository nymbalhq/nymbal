import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { kernelConfig, MIGRATIONS_ROOT, type Kernel } from '../kernel.js'
import { openRaw } from '../raw.js'

// P1-13 AC-8 (decision 1, M7) on one dialect: the schema as it stands before migration 0006, one order per status with
// and without a payment intent (distinct totals, distinct updated_at), then every migration up to the newest. Each row's
// captured_minor, captured_at, refunded_minor and capture_method must be what decision 1's backfill states, and no
// refund row is invented. Kills: 0006 missing or failing on this dialect, captured set for pending or cancelled orders,
// captured_at not taken from updated_at, refunded orders left with nothing refunded, partially_refunded given an
// amount nobody knows, and capture_method not split provider / import by the intent.

const STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
] as const
type Status = (typeof STATUSES)[number]

/** Confirmed or later, and not cancelled: the orders 0006 takes as captured in full. */
const CAPTURED: ReadonlySet<Status> = new Set([
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'refunded',
  'partially_refunded',
])

/** A copy of the migrations folder for `dialect` holding every migration before 0006: the schema before this task. */
function migrationsBefore0006(dialect: Kernel['dialect']): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'p1-13-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 5)
  if (journal.entries.length !== 6) throw new Error(`expected migrations 0000-0005 in ${from}`)
  for (const entry of journal.entries) {
    cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
  }
  writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

async function migrate(dialect: Kernel['dialect'], target: string, root: string): Promise<void> {
  const storage = dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
  const store = createCommandStore(kernelConfig(dialect), storage)
  try {
    await runMigrations(store, { migrationsRoot: root })
  } finally {
    await store.close()
  }
}

interface LegacyOrder {
  id: string
  orderNumber: string
  sequence: number
  status: Status
  totalMinor: number
  paymentIntentId: string | null
  createdAt: string
  updatedAt: string
}

function legacyOrders(): LegacyOrder[] {
  const rows: LegacyOrder[] = []
  let n = 0
  for (const status of STATUSES) {
    for (const withIntent of [true, false]) {
      n += 1
      rows.push({
        id: randomUUID(),
        orderNumber: `LEG-${1000 + n}`,
        sequence: 1000 + n,
        status,
        totalMinor: 1_000 + n * 137,
        paymentIntentId: withIntent ? `pi_legacy_${n}` : null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 9, 0, n)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 1, 2, 10, n, 7, n)).toISOString(),
      })
    }
  }
  return rows
}

async function insertLegacy(
  dialect: Kernel['dialect'],
  target: string,
  rows: LegacyOrder[],
): Promise<void> {
  const columns =
    'id, order_number, sequence, customer_id, status, email, billing_address, shipping_address, line_items, ' +
    'subtotal_minor, total_minor, currency, payment_intent_id, created_at, updated_at'
  const addressJson = JSON.stringify({ firstName: 'Ada', lastName: 'Legacy', country: 'GB' })
  if (dialect === 'sqlite') {
    const db = new Database(target)
    try {
      const insert = db.prepare(
        `INSERT INTO orders (${columns}) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '[]', ?, ?, 'GBP', ?, ?, ?)`,
      )
      for (const r of rows) {
        insert.run(
          r.id,
          r.orderNumber,
          r.sequence,
          r.status,
          `${r.orderNumber}@p1-13.test`,
          addressJson,
          addressJson,
          r.totalMinor,
          r.totalMinor,
          r.paymentIntentId,
          r.createdAt,
          r.updatedAt,
        )
      }
    } finally {
      db.close()
    }
    return
  }
  const pool = new pg.Pool({ connectionString: target, max: 1 })
  try {
    for (const r of rows) {
      await pool.query(
        `INSERT INTO orders (${columns}) VALUES ($1, $2, $3, NULL, $4, $5, $6::jsonb, $6::jsonb, '[]'::jsonb, $7, $7, 'GBP', $8, $9, $10)`,
        [
          r.id,
          r.orderNumber,
          r.sequence,
          r.status,
          `${r.orderNumber}@p1-13.test`,
          addressJson,
          r.totalMinor,
          r.paymentIntentId,
          r.createdAt,
          r.updatedAt,
        ],
      )
    }
  } finally {
    await pool.end()
  }
}

const instant = (value: unknown): number | null =>
  value === null || value === undefined
    ? null
    : new Date(value instanceof Date ? value : String(value)).getTime()

export function moneyMigrationSuite(
  dialect: Kernel['dialect'],
  /** A fresh, empty database: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`migration 0006: order money (${dialect})`, () => {
    it('AC-8: after 0006, an order confirmed or later and not cancelled has captured_minor = total_minor and captured_at = updated_at; pending and cancelled have 0 and null; refunded has refunded_minor = captured_minor; partially_refunded keeps refunded_minor 0; capture_method is provider with an intent, import without one, null when nothing is captured; no refund row is made', async () => {
      const db = await fresh()
      const before = migrationsBefore0006(dialect)
      try {
        await migrate(dialect, db.target, before.root)
        const legacy = legacyOrders()
        await insertLegacy(dialect, db.target, legacy)

        await migrate(dialect, db.target, MIGRATIONS_ROOT)

        const raw = openRaw(dialect, db.target)
        try {
          for (const order of legacy) {
            const label = `${order.status} ${order.paymentIntentId === null ? 'without' : 'with'} intent`
            const row = await raw.one<{
              total_minor: number | string
              captured_minor: number | string
              refunded_minor: number | string
              capture_method: string | null
              captured_at: unknown
              updated_at: unknown
            }>(
              'SELECT total_minor, captured_minor, refunded_minor, capture_method, captured_at, updated_at FROM orders WHERE id = ?',
              [order.id],
            )
            const total = Number(row.total_minor)
            const captured = Number(row.captured_minor)
            const refunded = Number(row.refunded_minor)
            const isCaptured = CAPTURED.has(order.status)

            expect(total, label).toBe(order.totalMinor)
            expect(captured, label).toBe(isCaptured ? total : 0)
            expect(instant(row.captured_at), label).toBe(
              isCaptured ? instant(row.updated_at) : null,
            )
            expect(instant(row.updated_at), label).toBe(instant(order.updatedAt))
            expect(refunded, label).toBe(order.status === 'refunded' ? captured : 0)
            expect(row.capture_method, label).toBe(
              !isCaptured ? null : order.paymentIntentId === null ? 'import' : 'provider',
            )
            expect(refunded, label).toBeLessThanOrEqual(captured)
            expect(captured, label).toBeLessThanOrEqual(total)
          }
          expect(await raw.count('order_refunds')).toBe(0)
        } finally {
          await raw.close()
        }
      } finally {
        before.drop()
        await db.drop()
      }
    })
  })
}
