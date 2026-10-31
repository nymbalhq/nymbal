import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import fc from 'fast-check'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { createOrderAccessKeyRepository } from '../../../src/repositories/order-access-key.js'
import {
  checkoutOf,
  createKernel,
  kernelConfig,
  MIGRATIONS_ROOT,
  seedVariant,
  type Kernel,
} from '../kernel.js'
import { eventRows } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'

// AC-1 on one dialect: a key opens its order until its row's `expires_at` and not after, `now` passed to `opens`.
// Rows that existed before the expiry migration are backfilled with `created_at` plus their purpose's lifetime
// (48 hours for a checkout key, 30 days for an email key), as an instant in UTC; keys minted after it carry the
// configured lifetime (`commerce.orders.keyLifetime`, 48h and 30d by default).

const HOUR = 3_600_000
const DAY = 24 * HOUR
const BACKFILL = { checkout: 48 * HOUR, email: 30 * DAY } as const
type Purpose = keyof typeof BACKFILL

/** ISO 8601 in UTC, as the SQLite repository writes `created_at`: what `Date.parse` reads the same in any zone. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export interface FreshTarget {
  target: string
  drop(): Promise<void>
}

interface LegacyKey {
  id: string
  orderId: string
  keyHash: string
  purpose: Purpose
  createdAt: Date
}

const legacyKey: fc.Arbitrary<LegacyKey> = fc.record({
  id: fc.uuid(),
  orderId: fc.uuid(),
  keyHash: fc
    .uint8Array({ minLength: 32, maxLength: 32 })
    .map((b) => sha256(Buffer.from(b).toString('base64url'))),
  purpose: fc.constantFrom<Purpose>('checkout', 'email'),
  createdAt: fc.date({
    min: new Date('2024-01-01T00:00:00.000Z'),
    max: new Date('2026-10-30T00:00:00.000Z'),
    noInvalidDate: true,
  }),
})

/** A copy of the migrations folder for `dialect` holding every migration before 0018: the schema before expiry. */
function migrationsBeforeExpiry(dialect: Kernel['dialect']): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'key-expiry-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 17)
  if (journal.entries.length !== 18) throw new Error(`expected migrations 0000-0017 in ${from}`)
  for (const entry of journal.entries)
    cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
  writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

const storageOf = (dialect: Kernel['dialect'], target: string) =>
  dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }

async function migrate(dialect: Kernel['dialect'], target: string, root: string): Promise<void> {
  const store = createCommandStore(kernelConfig(dialect), storageOf(dialect, target))
  try {
    await runMigrations(store, { migrationsRoot: root })
  } finally {
    await store.close()
  }
}

async function insertLegacy(
  dialect: Kernel['dialect'],
  target: string,
  rows: LegacyKey[],
): Promise<void> {
  const sql = 'INSERT INTO order_access_keys (id, order_id, key_hash, purpose, created_at) VALUES '
  if (dialect === 'sqlite') {
    const db = new Database(target)
    try {
      const insert = db.prepare(`${sql}(?, ?, ?, ?, ?)`)
      for (const r of rows)
        insert.run(r.id, r.orderId, r.keyHash, r.purpose, r.createdAt.toISOString())
    } finally {
      db.close()
    }
    return
  }
  const pool = new pg.Pool({ connectionString: target, max: 1 })
  try {
    for (const r of rows) {
      await pool.query(`${sql}($1, $2, $3, $4, $5)`, [
        r.id,
        r.orderId,
        r.keyHash,
        r.purpose,
        r.createdAt.toISOString(),
      ])
    }
  } finally {
    await pool.end()
  }
}

async function columnsOf(raw: RawReader, dialect: Kernel['dialect']): Promise<string[]> {
  const rows =
    dialect === 'sqlite'
      ? await raw.rows<{ name: string }>("SELECT name FROM pragma_table_info('order_access_keys')")
      : await raw.rows<{ name: string }>(
          "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'order_access_keys'",
        )
  return rows.map((r) => r.name).sort()
}

/** A stored instant as epoch ms: SQLite text must be ISO UTC (a bare `datetime()` would read as local time). */
function instant(dialect: Kernel['dialect'], value: unknown, label: string): number {
  if (dialect === 'postgres') return new Date(value as string | Date).getTime()
  expect(String(value), `${label}: stored as ISO UTC text`).toMatch(ISO_UTC)
  return Date.parse(String(value))
}

interface KeyRow {
  key_hash: string
  purpose: Purpose
  created_at: unknown
  expires_at: unknown
}

type Opens = (orderId: string, keyHash: string, now: Date) => Promise<unknown>

export function orderKeyExpirySuite(
  dialect: Kernel['dialect'],
  fresh: (tag: string) => Promise<FreshTarget>,
): void {
  describe(`AC-1: an order key opens its order until its lifetime ends (${dialect})`, () => {
    // Kills: a key that opens forever; a backfill that leaves rows unbounded, adds the wrong lifetime, or writes local
    // time; `opens` comparing against the wall clock instead of `now`, or matching another order's row.
    it(`AC-1: property: rows written before the expiry migration are backfilled to created_at + 48 h (checkout) or + 30 d (email) as a UTC instant, and opens(order, hash, now) is 'open' before that instant and 'expired' after it, over purposes, creation times and read times; another order’s id or an unknown hash is 'none' (${dialect})`, async () => {
      const db = await fresh('key_backfill')
      const before = migrationsBeforeExpiry(dialect)
      const legacy = fc.sample(legacyKey, 30)
      try {
        await migrate(dialect, db.target, before.root)
        await insertLegacy(dialect, db.target, legacy)
        await migrate(dialect, db.target, MIGRATIONS_ROOT)

        const raw = openRaw(dialect, db.target)
        const store = createCommandStore(kernelConfig(dialect), storageOf(dialect, db.target))
        try {
          expect(
            await columnsOf(raw, dialect),
            'order_access_keys columns after the migration',
          ).toContain('expires_at')
          const stored = await raw.rows<KeyRow & { id: string }>(
            'SELECT id, key_hash, purpose, created_at, expires_at FROM order_access_keys',
          )
          const byId = new Map(stored.map((r) => [r.id, r]))
          const expiry = new Map<string, number>()
          for (const k of legacy) {
            const row = byId.get(k.id)!
            const label = `${k.purpose} key created ${k.createdAt.toISOString()}`
            expect(instant(dialect, row.created_at, `${label}: created_at`), label).toBe(
              k.createdAt.getTime(),
            )
            const expires = instant(dialect, row.expires_at, `${label}: expires_at`)
            expect(expires - k.createdAt.getTime(), `${label}: expires_at - created_at`).toBe(
              BACKFILL[k.purpose],
            )
            expiry.set(k.id, expires)
          }

          const repo = createOrderAccessKeyRepository(store)
          const opens: Opens = (orderId, keyHash, now) =>
            store.read((tx) => repo.opens(tx, orderId, keyHash, now))
          await fc.assert(
            fc.asyncProperty(
              fc.constantFrom(...legacy),
              fc.double({ min: 0, max: 3, noNaN: true }),
              async (k, fraction) => {
                const lifetime = BACKFILL[k.purpose]
                const offset = Math.round(fraction * lifetime)
                fc.pre(offset !== lifetime)
                const now = new Date(k.createdAt.getTime() + offset)
                const label = `${k.purpose} key created ${k.createdAt.toISOString()}, read at ${now.toISOString()}`
                expect(await opens(k.orderId, k.keyHash, now), label).toBe(
                  now.getTime() < expiry.get(k.id)! ? 'open' : 'expired',
                )
                expect(
                  await opens(randomUUID(), k.keyHash, now),
                  `${label}, as another order`,
                ).toBe('none')
                expect(
                  await opens(k.orderId, sha256(randomUUID()), now),
                  `${label}, an unknown hash`,
                ).toBe('none')
              },
            ),
            { numRuns: 60 },
          )
        } finally {
          await store.close()
          await raw.close()
        }
      } finally {
        before.drop()
        await db.drop()
      }
    }, 60_000)

    // Kills: a mint that writes no expiry or a hardcoded one; one lifetime used for both purposes.
    it(`AC-1: keys minted after the migration expire at created_at plus the configured lifetime: 48 h and 30 d by default, 90 min and 3 d when commerce.orders.keyLifetime says so; opens is 'open' a second before that instant and 'expired' a second after (${dialect})`, async () => {
      const cases: Array<{
        label: string
        keyLifetime?: Record<Purpose, string>
        lifetime: Record<Purpose, number>
      }> = [
        { label: 'the default lifetimes', lifetime: { checkout: 48 * HOUR, email: 30 * DAY } },
        {
          label: 'keyLifetime { checkout: 90m, email: 3d }',
          keyLifetime: { checkout: '90m', email: '3d' },
          lifetime: { checkout: 90 * 60_000, email: 3 * DAY },
        },
      ]
      for (const c of cases) {
        const db = await fresh('key_mint')
        let k: Kernel | undefined
        let raw: RawReader | undefined
        try {
          k = await createKernel({
            ...(dialect === 'sqlite'
              ? { dialect: 'sqlite' as const, sqlitePath: db.target }
              : { dialect: 'postgres' as const, postgresUrl: db.target }),
            // Parsed again as loadConfig parses a store's file, so the schema's own defaults and checks apply.
            configure: (config) =>
              nymbalConfigSchema.parse({
                ...config,
                store: { ...config.store, url: 'https://shop.test' },
                commerce: {
                  ...config.commerce,
                  orders: {
                    ...config.commerce.orders,
                    ...(c.keyLifetime !== undefined && { keyLifetime: c.keyLifetime }),
                  },
                },
              }),
          })
          raw = openRaw(dialect, db.target)
          const seeded = await seedVariant(k, 5)
          // A paid guest order: the checkout's key, then the order-placed email's.
          const started = await checkoutOf(
            k,
            seeded,
            1,
            `expiry-${randomBytes(4).toString('hex')}@expiry.test`,
          )
          const r = raw
          await vi.waitFor(
            async () => {
              const open = (await eventRows(r)).filter(
                (e) => e.deliveredAt == null && e.deadAt == null,
              )
              expect(open.map((e) => e.type)).toEqual([])
            },
            { timeout: 10_000, interval: 20 },
          )
          const rows = await raw.rows<KeyRow>(
            'SELECT key_hash, purpose, created_at, expires_at FROM order_access_keys WHERE order_id = ?',
            [started.orderId],
          )
          expect(rows.map((row) => row.purpose).sort(), `${c.label}: the order’s keys`).toEqual([
            'checkout',
            'email',
          ])
          const kernel = k
          for (const row of rows) {
            const label = `${c.label}: the ${row.purpose} key`
            const created = instant(dialect, row.created_at, `${label}: created_at`)
            const expires = instant(dialect, row.expires_at, `${label}: expires_at`)
            expect(expires - created, `${label}: expires_at - created_at`).toBe(
              c.lifetime[row.purpose],
            )
            const opensAt = (at: number) =>
              kernel.store.read((tx) =>
                kernel.repos.orderAccessKey.opens(tx, started.orderId, row.key_hash, new Date(at)),
              )
            expect(await opensAt(expires - 1000), `${label}, a second before it expires`).toBe(
              'open',
            )
            expect(await opensAt(expires + 1000), `${label}, a second after it expires`).toBe(
              'expired',
            )
          }
        } finally {
          await raw?.close()
          await k?.close()
          await db.drop()
        }
      }
    }, 60_000)
  })
}
