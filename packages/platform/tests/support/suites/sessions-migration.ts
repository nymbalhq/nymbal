import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeJwt, SignJWT } from 'jose'
import { v7 as uuidv7 } from 'uuid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandStore, type CommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../../src/event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../../../src/index.js'
import { createLogger } from '../../../src/logger.js'
import { buildRepositories } from '../../../src/repositories/index.js'
import { createAuthService } from '../../../src/services/auth-service.js'
import { wirePublisher } from '../../../src/tests/publisher.js'
import { kernelConfig, MIGRATIONS_ROOT, type Dialect } from '../kernel.js'
import { openRaw, writeRaw } from '../raw.js'

// The migration that gives refresh_tokens its session columns, on one dialect. A database is migrated to the entry
// before it and given the rows a store held at the release: a live sign-in, a sign-in renewed inside the reuse window
// with its successor, and another live sign-in. It is then migrated to the head, and the release must sign nobody out
// and split no session. The tokens are signed as the store signs them; the clock is faked (Date only) and stands still.

const SECRET = 'migration-secret-32-characters-x'
const SESSION_COLUMNS = ['device', 'session_id', 'session_started_at']
const UNKNOWN = 'Unknown device'
const DAY_MS = 86_400_000

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>
}

const journalOf = (dialect: Dialect): Journal =>
  JSON.parse(
    readFileSync(join(MIGRATIONS_ROOT, dialect, 'meta', '_journal.json'), 'utf8'),
  ) as Journal

/** The journal entries whose SQL adds a session column to refresh_tokens. */
function sessionEntries(dialect: Dialect): Journal['entries'] {
  return journalOf(dialect).entries.filter((entry) => {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dialect, `${entry.tag}.sql`), 'utf8')
    return /refresh_tokens/.test(sql) && /session_id/.test(sql)
  })
}

/** A copy of the migrations folder holding every entry before the one that adds the session columns. */
function migrationsBefore(dialect: Dialect, idx: number): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'sessions-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = journalOf(dialect)
  journal.entries = journal.entries.filter((entry) => entry.idx < idx)
  for (const entry of journal.entries) {
    cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
  }
  writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

function storeOf(dialect: Dialect, target: string): CommandStore {
  return createCommandStore(
    kernelConfig(dialect),
    dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target },
  )
}

async function migrate(dialect: Dialect, target: string, root: string): Promise<void> {
  const store = storeOf(dialect, target)
  try {
    await runMigrations(store, { migrationsRoot: root })
  } finally {
    await store.close()
  }
}

interface Column {
  name: string
  nullable: boolean
}

async function columnsOf(dialect: Dialect, target: string): Promise<Column[]> {
  const raw = openRaw(dialect, target)
  try {
    const rows =
      dialect === 'sqlite'
        ? await raw.rows<{ name: string; notnull: number }>('PRAGMA table_info(refresh_tokens)')
        : await raw.rows<{ name: string; notnull: number }>(
            `SELECT column_name AS name, CASE is_nullable WHEN 'YES' THEN 0 ELSE 1 END AS notnull
               FROM information_schema.columns WHERE table_name = 'refresh_tokens'`,
          )
    return rows
      .map((row) => ({ name: row.name, nullable: Number(row.notnull) === 0 }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } finally {
    await raw.close()
  }
}

/** A refresh token as the store signs one for this row. */
async function refreshTokenFor(customerId: string, email: string, jti: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: customerId, email, roles: ['customer'], type: 'refresh', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setJti(jti)
    .setIssuer('nymbal')
    .setExpirationTime(now + 7 * 24 * 3600)
    .sign(new TextEncoder().encode(SECRET))
}

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex')
const iso = (ms: number): string => new Date(ms).toISOString()

export function sessionsMigrationSuite(
  dialect: Dialect,
  /** A fresh, empty database: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`refresh_tokens gains its session columns (${dialect})`, () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: Math.floor(Date.now() / 1000) * 1000 })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    // Defect: the columns are added NOT NULL (the migration fails on a store with sessions, or has to write data), or
    // in more than one entry, or not at all.
    it('AC-11: one journal entry adds session_id, session_started_at and device to refresh_tokens, each nullable, and nothing else', async () => {
      const entries = sessionEntries(dialect)
      expect(entries.map((entry) => entry.tag)).toHaveLength(1)
      const db = await fresh()
      const before = migrationsBefore(dialect, entries[0]!.idx)
      try {
        await migrate(dialect, db.target, before.root)
        const prior = (await columnsOf(dialect, db.target)).map((column) => column.name)
        await migrate(dialect, db.target, MIGRATIONS_ROOT)

        const added = (await columnsOf(dialect, db.target)).filter(
          (column) => !prior.includes(column.name),
        )

        expect(added).toEqual(SESSION_COLUMNS.map((name) => ({ name, nullable: true })))
      } finally {
        before.drop()
        await db.drop()
      }
    })

    // Defect: the release signs every shopper out, or a session from before it splits in two at its next renewal (or
    // a fork of one renewal lists twice).
    it('AC-11: rows from before the migration: each token still refreshes, each successor’s session is its predecessor’s row id, and the list holds each legacy sign-in once, Unknown device, signed in at its createdAt', async () => {
      const entries = sessionEntries(dialect)
      expect(entries.map((entry) => entry.tag)).toHaveLength(1)
      const db = await fresh()
      const before = migrationsBefore(dialect, entries[0]!.idx)
      let store: CommandStore | undefined
      try {
        await migrate(dialect, db.target, before.root)
        const t0 = Date.now()
        const customerId = uuidv7()
        const email = `legacy-${customerId}@sessions.test`
        await writeRaw(
          dialect,
          db.target,
          'INSERT INTO customers (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [customerId, email, 'x', iso(t0 - DAY_MS), iso(t0 - DAY_MS)],
        )
        // live: a sign-in never renewed. renewed → successor: renewed 10 s ago, inside the window. twice: live, to be
        // renewed twice in the window after the release.
        const rows = {
          live: { id: uuidv7(), createdAt: t0 - 3_600_000 },
          renewed: { id: uuidv7(), createdAt: t0 - 7_200_000 },
          successor: { id: uuidv7(), createdAt: t0 - 10_000 },
          twice: { id: uuidv7(), createdAt: t0 - 1_800_000 },
        }
        const tokens = Object.fromEntries(
          await Promise.all(
            Object.entries(rows).map(
              async ([name, row]) =>
                [name, await refreshTokenFor(customerId, email, row.id)] as const,
            ),
          ),
        ) as Record<keyof typeof rows, string>
        for (const [name, row] of Object.entries(rows) as Array<
          [keyof typeof rows, (typeof rows)['live']]
        >) {
          const renewed = name === 'renewed'
          await writeRaw(
            dialect,
            db.target,
            `INSERT INTO refresh_tokens (id, customer_id, token_hash, revoked_at, replaced_by_jti, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              row.id,
              customerId,
              hashOf(tokens[name]),
              renewed ? iso(t0 - 10_000) : null,
              renewed ? rows.successor.id : null,
              iso(t0 + 6 * DAY_MS),
              iso(row.createdAt),
            ],
          )
        }

        const head = storeOf(dialect, db.target)
        store = head
        await runMigrations(head, { migrationsRoot: MIGRATIONS_ROOT })
        const repos = buildRepositories(head, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
        const logger = createLogger({ pretty: false, level: 'error' })
        const { publisher } = wirePublisher(
          { createEventPublisher, createRelay },
          { store: head, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
        )
        const auth = createAuthService({
          repos,
          publisher,
          logger,
          jwtSecret: SECRET,
          accessTtl: '15m',
          refreshTtl: '7d',
        })
        const legacy = (row: { id: string; createdAt: number }, lastActiveAt = row.createdAt) => ({
          id: row.id,
          device: UNKNOWN,
          signedInAt: iso(row.createdAt),
          lastActiveAt: iso(lastActiveAt),
          current: false,
        })

        expect(await auth.listSessions(customerId), 'at the release').toEqual([
          legacy(rows.successor),
          legacy(rows.twice),
          legacy(rows.live),
        ])

        const renewals: Array<[keyof typeof rows, number]> = [
          ['live', 1],
          ['renewed', 1],
          ['twice', 2],
        ]
        const successors: Record<string, Array<unknown>> = {}
        for (const [name, times] of renewals) {
          vi.setSystemTime(Date.now() + 1_000)
          for (let i = 0; i < times; i += 1) {
            const next = await auth.refresh(tokens[name])
            const row = await head.read((tx) =>
              repos.refreshToken.findById(
                tx,
                decodeJwt(next.refreshToken).jti as string,
              ),
            )
            ;(successors[name] ??= []).push(row?.sessionId)
          }
        }

        expect(successors).toEqual({
          live: [rows.live.id],
          renewed: [rows.renewed.id],
          twice: [rows.twice.id, rows.twice.id],
        })
        expect(await auth.listSessions(customerId), 'after the renewals').toEqual([
          legacy(rows.twice, t0 + 3_000),
          legacy(rows.renewed, t0 + 2_000),
          legacy(rows.live, t0 + 1_000),
          legacy(rows.successor),
        ])
      } finally {
        await store?.close()
        before.drop()
        await db.drop()
      }
    })
  })
}
