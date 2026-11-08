import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import fc from 'fast-check'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { hashOrderKey, mintOrderKey } from '../../../src/order-access-key.js'
import { adminSession } from '../audit-http.js'
import { orderView, readAsOf } from '../history.js'
import { serveKernel } from '../http.js'
import { address, createKernel, kernelConfig, MIGRATIONS_ROOT, type Kernel } from '../kernel.js'
import { openRaw } from '../raw.js'
import { unaudited } from '../write-audit.js'

// The data migration on one dialect, by the method of the money migration's suite: the schema through 0022, legacy
// orders with their history written straight to the tables, then every migration up to the newest. The reference
// below is the rule as a walk of the rows, in (timestamp, id) order.

type Status =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'

const FULFILMENT: Status[] = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']
const MONEY: readonly string[] = ['refunded', 'partially_refunded']
const isMoney = (s: string | null): boolean => s !== null && MONEY.includes(s)

interface HistoryRow {
  id: string
  from_status: Status | null
  to_status: Status
  note: string
  /** Milliseconds; a few distinct values, so rows of one order tie and the id settles their order. */
  at: number
}

interface LegacyOrder {
  id: string
  orderNumber: string
  sequence: number
  status: Status
  shipped: boolean
  updatedAt: string
  history: HistoryRow[]
}

const BASE = Date.UTC(2026, 3, 1, 9, 0, 0)

/** The rows rewritten in `timestamp, id` order and, for a money-status order, its status after. */
function referenceOf(order: LegacyOrder): { rows: HistoryRow[]; status: Status } {
  const walked = [...order.history].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  let effective: Status | null = null
  const rows = walked.map((row) => {
    const from = isMoney(row.from_status) ? (effective ?? 'confirmed') : row.from_status
    const to = isMoney(row.to_status)
      ? isMoney(row.from_status) || row.from_status === null
        ? (effective ?? 'confirmed')
        : (row.from_status as Status)
      : row.to_status
    effective = to
    return { ...row, from_status: from, to_status: to }
  })
  if (!isMoney(order.status)) return { rows, status: order.status }
  const last = rows.at(-1)
  return {
    rows,
    status: last !== undefined ? last.to_status : order.shipped ? 'shipped' : 'confirmed',
  }
}

const arbStatus = fc.constantFrom<Status>(...FULFILMENT, 'refunded', 'partially_refunded')
const arbRow: fc.Arbitrary<Omit<HistoryRow, 'id'>> = fc.record({
  from_status: fc.option(arbStatus, { nil: null }),
  to_status: arbStatus,
  note: fc.constantFrom('', 'refund of £1.00', 'Shipped via dpd: T-1', 'captured payment not applied: x'),
  at: fc.integer({ min: 0, max: 6 }).map((n) => BASE + n * 1000),
})
const arbOrder = fc.record({
  status: arbStatus,
  shipped: fc.boolean(),
  history: fc.array(arbRow, { maxLength: 7 }),
})

interface Sql {
  exec(sql: string, params?: unknown[]): Promise<void>
  close(): Promise<void>
}

function openWrite(dialect: Kernel['dialect'], target: string): Sql {
  if (dialect === 'sqlite') {
    const db = new Database(target)
    return {
      async exec(sql, params = []) {
        db.prepare(sql).run(...params)
      },
      async close() {
        db.close()
      },
    }
  }
  const pool = new pg.Pool({ connectionString: target, max: 1 })
  return {
    async exec(sql, params = []) {
      let n = 0
      await pool.query(sql.replace(/\?/g, () => `$${(n += 1)}`), params)
    },
    async close() {
      await pool.end()
    },
  }
}

const THROUGH = 22

/** A copy of the migrations folder for `dialect` holding every migration through 0022. */
function migrationsThrough(dialect: Kernel['dialect']): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'status-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= THROUGH)
  if (journal.entries.length !== THROUGH + 1) throw new Error(`expected 0000-0022 in ${from}`)
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

const ORDER_COLUMNS =
  'id, order_number, sequence, customer_id, status, email, billing_address, shipping_address, line_items, ' +
  'subtotal_minor, total_minor, currency, captured_minor, refunded_minor, capture_method, created_at, updated_at'

async function insertLegacy(
  dialect: Kernel['dialect'],
  target: string,
  orders: LegacyOrder[],
): Promise<void> {
  const db = openWrite(dialect, target)
  const addr = JSON.stringify({ firstName: 'Ada', lastName: 'Legacy', country: 'GB' })
  const cast = dialect === 'sqlite' ? '' : '::jsonb'
  try {
    for (const o of orders) {
      const refunded = o.status === 'refunded' ? 2500 : o.status === 'partially_refunded' ? 700 : 0
      await db.exec(
        `INSERT INTO orders (${ORDER_COLUMNS}) VALUES (?, ?, ?, NULL, ?, ?, ?${cast}, ?${cast}, '[]'${cast}, 2500, 2500, 'GBP', 2500, ?, 'provider', ?, ?)`,
        [
          o.id,
          o.orderNumber,
          o.sequence,
          o.status,
          `${o.orderNumber}@status.test`,
          addr,
          addr,
          refunded,
          o.updatedAt,
          o.updatedAt,
        ],
      )
      for (const row of o.history) {
        await db.exec(
          'INSERT INTO order_history (id, order_id, from_status, to_status, actor, note, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            row.id,
            o.id,
            row.from_status,
            row.to_status,
            'system:legacy',
            row.note,
            new Date(row.at).toISOString(),
          ],
        )
      }
      if (o.shipped) {
        await db.exec(
          'INSERT INTO order_shipments (order_id, carrier, tracking_number, created_at) VALUES (?, ?, ?, ?)',
          [o.id, 'dpd', `T-${o.sequence}`, o.updatedAt],
        )
      }
    }
  } finally {
    await db.close()
  }
}

const instant = (value: unknown): number =>
  new Date(value instanceof Date ? value : String(value)).getTime()

function stable(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
  )
}

async function dump(dialect: Kernel['dialect'], target: string) {
  const raw = openRaw(dialect, target)
  try {
    return {
      orders: (await raw.rows<Record<string, unknown>>('SELECT * FROM orders ORDER BY id')).map(
        stable,
      ),
      history: (
        await raw.rows<Record<string, unknown>>('SELECT * FROM order_history ORDER BY id')
      ).map(stable),
    }
  } finally {
    await raw.close()
  }
}

let sequence = 5000

function draftToLegacy(draft: { status: Status; shipped: boolean; history: Array<Omit<HistoryRow, 'id'>> }): LegacyOrder {
  sequence += 1
  return {
    id: randomUUID(),
    orderNumber: `MIG-${sequence}`,
    sequence,
    status: draft.status,
    shipped: draft.shipped,
    updatedAt: new Date(Date.UTC(2026, 4, 2, 10, 0, sequence % 60, sequence % 1000)).toISOString(),
    history: draft.history.map((row) => ({ ...row, id: randomUUID() })),
  }
}

export function orderStatusMigrationSuite(
  dialect: Kernel['dialect'],
  /** A fresh, empty database: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
  opts: { runs: number },
): void {
  describe(`migration 0023: order status is fulfilment only (${dialect})`, () => {
    /** The schema through 0022 with these orders written, then migrated to the newest. */
    async function migrated(target: string, orders: LegacyOrder[]) {
      const before = migrationsThrough(dialect)
      try {
        await migrate(dialect, target, before.root)
        await insertLegacy(dialect, target, orders)
        const dumped = await dump(dialect, target)
        await migrate(dialect, target, MIGRATIONS_ROOT)
        return { dumped, after: await dump(dialect, target) }
      } finally {
        before.drop()
      }
    }

    // Defect: a legacy row keeps a money status, a shipped order migrates to confirmed, the walk is wrong on a from-money
    // row, updated_at or a note changes, or a row is added or dropped.
    it(`AC-13: property: after migrating, every order’s history matches the reference walk row for row, its status the reference’s (a money order with no history reads shipped with a shipment row, else confirmed), no money value remains, notes and updated_at unchanged and non-money orders’ rows byte-identical (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(arbOrder, { minLength: 1, maxLength: 8 }), async (drafts) => {
          const orders = drafts.map(draftToLegacy)
          const db = await fresh()
          try {
            const { dumped, after } = await migrated(db.target, orders)
            const historyOf = (rows: Array<Record<string, unknown>>, id: string) =>
              rows.filter((r) => r['order_id'] === id)

            expect(after.history.length, 'no row added or removed').toBe(orders.flatMap((o) => o.history).length)

            for (const order of orders) {
              const reference = referenceOf(order)
              const rows = historyOf(after.history, order.id)
              const byId = new Map(rows.map((r) => [r['id'] as string, r]))
              const context = JSON.stringify(order)
              expect(
                reference.rows.map((r) => [r.id, r.from_status, r.to_status, r.note]),
                context,
              ).toEqual(
                reference.rows.map((r) => {
                  const row = byId.get(r.id)!
                  return [r.id, row['from_status'], row['to_status'], row['note']]
                }),
              )
              const orderRow = after.orders.find((o) => o['id'] === order.id)!
              expect(orderRow['status'], `${context}: orders.status`).toBe(reference.status)
              expect(instant(orderRow['updated_at']), `${context}: updated_at`).toBe(instant(order.updatedAt))
              if (!isMoney(order.status)) {
                const dumpedOrder = dumped.orders.find((o) => o['id'] === order.id)!
                expect(orderRow, `${context}: a non-money order`).toEqual(dumpedOrder)
              }
              if (!order.history.some((r) => isMoney(r.from_status) || isMoney(r.to_status))) {
                expect(rows, `${context}: a history with no money value`).toEqual(
                  historyOf(dumped.history, order.id),
                )
              }
            }
            expect(
              after.orders.filter((o) => isMoney(o['status'] as string)).map((o) => o['status']),
              'orders.status money values',
            ).toEqual([])
            expect(
              after.history
                .flatMap((r) => [r['from_status'], r['to_status']])
                .filter((s) => s !== null && isMoney(s as string)),
              'order_history money values',
            ).toEqual([])
          } finally {
            await db.drop()
          }
        }),
        { numRuns: opts.runs },
      )
    }, 300_000)

    // Defect: re-running the statement changes a row (it must be a no-op), or a boot still serves the old money status
    // from a read model, or the event log's stored snapshot leaks it on an as-of read.
    it(`AC-13: applying 0023 again changes nothing; the next boot serves the migrated status in GET /api/admin/orders and /api/orders/:n; AC-9: a migrated import’s ?at= equals its live read (${dialect})`, async () => {
      const db = await fresh()
      const orders: LegacyOrder[] = [
        draftToLegacy({ status: 'refunded', shipped: false, history: [] }),
        draftToLegacy({ status: 'partially_refunded', shipped: true, history: [] }),
        draftToLegacy({
          status: 'refunded',
          shipped: true,
          history: [
            { from_status: null, to_status: 'pending', note: 'order draft created', at: BASE },
            { from_status: 'pending', to_status: 'confirmed', note: 'payment captured', at: BASE + 1 },
            { from_status: 'confirmed', to_status: 'refunded', note: 'refund of £25.00', at: BASE + 2 },
          ],
        }),
      ]
      try {
        const { after } = await migrated(db.target, orders)
        const expectedStatuses = ['confirmed', 'shipped', 'confirmed']
        expect(
          orders.map((o) => after.orders.find((r) => r['id'] === o.id)!['status']),
          'a money order with no history reads shipped with a shipment row, confirmed without',
        ).toEqual(expectedStatuses)

        const file = join(MIGRATIONS_ROOT, dialect, '0023_order_status_fulfilment.sql')
        expect(existsSync(file), 'the migration file').toBe(true)
        const statements = readFileSync(file, 'utf8')
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter((s) => s !== '')
        const again = openWrite(dialect, db.target)
        try {
          for (const statement of statements) await again.exec(statement)
        } finally {
          await again.close()
        }
        expect(await dump(dialect, db.target), 'applying again').toEqual(after)

        const k = await createKernel(
          dialect === 'sqlite'
            ? { dialect, sqlitePath: db.target }
            : { dialect, postgresUrl: db.target },
        )
        const served = await serveKernel(k)
        try {
          const admin = await adminSession(k, served.baseUrl)
          const listed = await admin.send<Array<{ orderNumber: string; status: string }>>(
            'GET',
            '/api/admin/orders?limit=200',
          )
          const statusOf = new Map(
            (listed.body.data ?? []).map((row) => [row.orderNumber, row.status]),
          )
          expect(orders.map((o) => statusOf.get(o.orderNumber))).toEqual(expectedStatuses)

          const { key } = mintOrderKey()
          const now = new Date()
          await unaudited(() =>
            k.store.transaction((tx) =>
              k.repos.orderAccessKey.insert(tx, {
                id: randomUUID(),
                orderId: orders[1]!.id,
                keyHash: hashOrderKey(key),
                purpose: 'checkout',
                createdAt: now,
                expiresAt: new Date(now.getTime() + 3_600_000),
              }),
            ),
          )
          const shopper = await fetch(`${served.baseUrl}/api/orders/${orders[1]!.orderNumber}`, {
            headers: { accept: 'application/json', 'x-nymbal-order-key': key },
          })
          const shopperBody = (await shopper.json()) as { data?: { status?: string } }
          expect([shopper.status, shopperBody.data?.status]).toEqual([200, 'shipped'])

          // An imported order the migration moved to confirmed: its stored `order.placed` still carries the money status
          // the row held then, and the as-of read of the log must equal the live read of the row.
          const importedId = randomUUID()
          const importedNumber = `IMP-${randomUUID().slice(0, 8)}`
          const createdAt = new Date(Date.now() - 3_600_000).toISOString()
          const cast = dialect === 'sqlite' ? '' : '::jsonb'
          const write = openWrite(dialect, db.target)
          try {
            await write.exec(
              `INSERT INTO orders (id, order_number, sequence, customer_id, status, email, billing_address, shipping_address, line_items, subtotal_minor, total_minor, currency, captured_minor, refunded_minor, capture_method, source, created_at, updated_at) VALUES (?, ?, 9000, NULL, 'confirmed', ?, ?${cast}, ?${cast}, '[]'${cast}, 2500, 2500, 'GBP', 2500, 2500, 'import', 'import', ?, ?)`,
              [
                importedId,
                importedNumber,
                `${importedNumber}@status.test`,
                JSON.stringify(address),
                JSON.stringify(address),
                createdAt,
                createdAt,
              ],
            )
            const live = await admin.send<Record<string, unknown>>(
              'GET',
              `/api/admin/orders/${importedNumber}`,
            )
            const { payment: _p, history: _h, ...row } = live.body.data as Record<string, unknown>
            const snapshot = { ...row, status: 'refunded' }
            const envelope = {
              id: randomUUID(),
              type: 'order.placed.v1',
              timestamp: createdAt,
              source: 'nymbal',
              correlationId: randomUUID(),
              payload: { order: snapshot },
              metadata: { storeId: 'store', environment: 'test', version: '1' },
            }
            await write.exec(
              `INSERT INTO events (id, type, envelope, correlation_id, created_at, subject_type, subject_id) VALUES (?, ?, ?${cast}, ?, ?, 'order', ?)`,
              [
                envelope.id,
                envelope.type,
                JSON.stringify(envelope),
                envelope.correlationId,
                createdAt,
                importedId,
              ],
            )
          } finally {
            await write.close()
          }
          const live = await admin.send<Record<string, unknown>>(
            'GET',
            `/api/admin/orders/${importedNumber}`,
          )
          const asOf = await readAsOf(admin, 'order', importedNumber, new Date().toISOString())
          expect(asOf.status, JSON.stringify(asOf.body)).toBe(200)
          expect(asOf.body.data?.record, 'as-of equals the live read').toEqual(
            orderView(live.body.data as Record<string, unknown>),
          )
        } finally {
          await served.stop()
        }
      } finally {
        await db.drop()
      }
    }, 180_000)
  })
}
