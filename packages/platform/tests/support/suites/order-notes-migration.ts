import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { OrderLineItem } from '@nymbalhq/types'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, createKernel, kernelConfig, MIGRATIONS_ROOT, type Kernel } from '../kernel.js'
import { adminClient } from '../money.js'

// The staff notes column on one dialect: a database one migration before it, holding an order with a plain checkout
// note and one whose notes column holds a JSON entry list, migrated to the head, lists each column's text as the
// customer's one note, and a note an admin posts afterwards is listed second.

type Fresh = () => Promise<{ target: string; drop(): Promise<void> }>

interface Note {
  body: string
  actor: string
  at: string
}

const COLUMN = /\bstaff_notes\b/

/** A copy of the migrations folder for `dialect` holding every migration before the one adding `orders.staff_notes`. */
function migrationsBeforeStaffNotes(dialect: Kernel['dialect']): { root: string; drop(): void } {
  const from = join(MIGRATIONS_ROOT, dialect)
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  const adding = journal.entries.find((entry) =>
    COLUMN.test(readFileSync(join(from, `${entry.tag}.sql`), 'utf8')),
  )
  if (adding === undefined) {
    throw new Error(`expected a migration in ${from} adding orders.staff_notes`)
  }
  const root = mkdtempSync(join(tmpdir(), 'staff-notes-migrations-'))
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  journal.entries = journal.entries.filter((entry) => entry.idx < adding.idx)
  for (const entry of journal.entries) {
    cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
  }
  writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

function storage(dialect: Kernel['dialect'], target: string) {
  return dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
}

async function migrate(dialect: Kernel['dialect'], target: string, root: string): Promise<void> {
  const store = createCommandStore(kernelConfig(dialect), storage(dialect, target))
  try {
    await runMigrations(store, { migrationsRoot: root })
  } finally {
    await store.close()
  }
}

const line: OrderLineItem = {
  variantId: 'notes-variant',
  productId: 'notes-product',
  productName: 'Notes Widget',
  variantName: 'Default',
  sku: 'NOTES-1',
  qty: 1,
  unitPriceMinor: 2500,
  lineSubtotalMinor: 2500,
  lineTaxMinor: 0,
  lineTotalMinor: 2500,
  imageUrl: '',
}

const PLAIN = 'Leave it with the neighbour at number 3'
const LISTED = JSON.stringify([
  { body: PLAIN, actor: 'customer', at: '2026-11-01T09:00:00.000Z' },
  { body: 'Refund agreed', actor: 'admin:u-1', at: '2026-11-01T10:00:00.000Z' },
])

interface Before {
  id: string
  orderNumber: string
  notes: string
}

/** Two orders written as the schema stood before the staff notes column: a plain note and a JSON entry list. */
async function insertBeforeStaffNotes(
  dialect: Kernel['dialect'],
  target: string,
): Promise<Before[]> {
  const now = new Date().toISOString()
  const orders: Before[] = [PLAIN, LISTED].map((notes) => {
    const id = randomUUID()
    return { id, orderNumber: `NOTES-${id.slice(0, 8)}`, notes }
  })
  const sql =
    'INSERT INTO orders (id, order_number, sequence, customer_id, status, email, billing_address, shipping_address, ' +
    'line_items, subtotal_minor, total_minor, currency, notes, metadata, created_at, updated_at) ' +
    "VALUES (?, ?, ?, NULL, 'confirmed', ?, ?, ?, ?, 2500, 2500, 'GBP', ?, '{}', ?, ?)"
  const params = orders.map((o, i) => [
    o.id,
    o.orderNumber,
    800_000 + i,
    `${o.orderNumber.toLowerCase()}@notes.test`,
    JSON.stringify(address),
    JSON.stringify(address),
    JSON.stringify([line]),
    o.notes,
    now,
    now,
  ])
  if (dialect === 'sqlite') {
    const db = new Database(target)
    try {
      for (const p of params) db.prepare(sql).run(...p)
    } finally {
      db.close()
    }
    return orders
  }
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    for (const p of params) {
      let n = 0
      await client.query(
        sql.replace(/\?/g, () => `$${(n += 1)}`),
        p,
      )
    }
  } finally {
    await client.end()
  }
  return orders
}

export function orderNotesMigrationSuite(dialect: Kernel['dialect'], fresh: Fresh): void {
  describe(`the staff notes column (${dialect})`, () => {
    // Kills: the column landing nullable with no default (the first staff note lost to NULL), or a backfill that parses
    // the notes column.
    it(`AC-4: a database one migration before the staff notes column, holding an order with a plain note and one with a JSON entry list, migrated to the head, lists each column’s text as one customer note, and a note posted afterwards is listed second (${dialect})`, async () => {
      const db = await fresh()
      const before = migrationsBeforeStaffNotes(dialect)
      let served: ServedKernel | undefined
      try {
        await migrate(dialect, db.target, before.root)
        const orders = await insertBeforeStaffNotes(dialect, db.target)

        await migrate(dialect, db.target, MIGRATIONS_ROOT)

        served = await serveKernel(
          await createKernel(
            dialect === 'sqlite'
              ? { dialect, sqlitePath: db.target }
              : { dialect, postgresUrl: db.target },
          ),
        )
        const admin = await adminClient(served.kernel, served.baseUrl)
        const seen: Array<{ migrated: Note[]; posted: number; after: Note[] }> = []
        const expected: typeof seen = []
        for (const o of orders) {
          const read = await admin.call<{ createdAt: string }>(
            'GET',
            `/api/admin/orders/${o.orderNumber}`,
          )
          const migrated = await admin.call<Note[]>('GET', `/api/admin/orders/${o.id}/notes`)
          const posted = await admin.call<{ note: Note }>(
            'POST',
            `/api/admin/orders/${o.id}/notes`,
            { body: 'Called the buyer' },
          )
          const after = await admin.call<Note[]>('GET', `/api/admin/orders/${o.id}/notes`)
          seen.push({
            migrated: migrated.body.data ?? [],
            posted: posted.status,
            after: after.body.data ?? [],
          })
          const customer = { body: o.notes, actor: 'customer', at: read.body.data!.createdAt }
          expected.push({
            migrated: [customer],
            posted: 200,
            after: [
              customer,
              {
                body: 'Called the buyer',
                actor: `admin:${admin.userId}`,
                at: posted.body.data?.note.at ?? '',
              },
            ],
          })
        }

        expect(seen).toEqual(expected)
      } finally {
        await served?.stop()
        before.drop()
        await db.drop()
      }
    }, 60_000)
  })
}
