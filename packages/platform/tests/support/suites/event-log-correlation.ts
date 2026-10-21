import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import fc from 'fast-check'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalEvent } from '@nymbalhq/types'
import { createCommandStore, type CommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../../src/document-store/in-memory.js'
import { createEventBuilder } from '../../../src/events/builder.js'
import { buildRepositories, type Repositories } from '../../../src/repositories/index.js'
import { TEST_BUILDER_CONTEXT } from '../../../src/tests/publisher.js'
import { kernelConfig, MIGRATIONS_ROOT, type Dialect } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'

// P3-01 AC-5, and the platform half of AC-6, on one dialect (spec P3-01-event-log-surface, decisions 6 and 7).
// AC-5: a database at migration 0007 holding events written by the old code (rows of the 0002 shape, inserted by a
// second connection) is migrated to the newest; `correlation_id` is backfilled from each envelope, falling back to the
// row's id, and `queryByCorrelation` returns each id's rows in seq order. Property: for any appended envelopes,
// `queryByCorrelation(c)` is exactly the envelopes whose correlationId is c, in seq order. AC-6: through the read-only
// opener (`readOnly: true`, as diagnose opens the store) the log can be queried and `append` rejects, leaving the log
// as it was. Repository methods take the transaction handle first, as every repository's do (tx-required.test-d.ts).
// Kills: old rows unqueryable after the migration, a column that disagrees with the envelope, results not in seq order,
// and a read path that can write.

const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

function storageFor(dialect: Dialect, target: string) {
  return dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
}

/** A copy of the migrations for `dialect` holding 0000-0007 only: the schema before this task. */
function migrationsTo0007(dialect: Dialect): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'p3-01-migrations-'))
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

async function migrate(dialect: Dialect, target: string, root: string): Promise<void> {
  const store = createCommandStore(kernelConfig(dialect), storageFor(dialect, target))
  try {
    await runMigrations(store, { migrationsRoot: root })
  } finally {
    await store.close()
  }
}

/** Inserts rows the way the code before 0008 did: id, type, envelope, created_at, nothing else. */
async function insertLegacy(
  dialect: Dialect,
  target: string,
  envelopes: Array<Record<string, unknown> & { id: string; type: string }>,
): Promise<void> {
  const createdAt = new Date().toISOString()
  if (dialect === 'sqlite') {
    const db = new Database(target)
    try {
      const insert = db.prepare(
        'INSERT INTO events (id, type, envelope, created_at) VALUES (?, ?, ?, ?)',
      )
      for (const e of envelopes) insert.run(e.id, e.type, JSON.stringify(e), createdAt)
    } finally {
      db.close()
    }
    return
  }
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    for (const e of envelopes) {
      await client.query(
        'INSERT INTO events (id, type, envelope, created_at) VALUES ($1, $2, $3::jsonb, $4)',
        [e.id, e.type, JSON.stringify(e), createdAt],
      )
    }
  } finally {
    await client.end()
  }
}

interface QueriedRow {
  seq: number
  event: NymbalEvent<unknown>
  deliveredAt: Date | null
}

function query(
  store: CommandStore,
  repos: Repositories,
  correlationId: string,
  types?: string[],
): Promise<QueriedRow[]> {
  return store.read((tx) =>
    repos.eventLog.queryByCorrelation(tx, correlationId, {
      limit: 1000,
      ...(types !== undefined && { types }),
    }),
  ) as Promise<QueriedRow[]>
}

export function eventLogCorrelationSuite(
  dialect: Dialect,
  /** A fresh, empty database: its target and how to drop it. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`P3-01 AC-5 and AC-6: the correlation_id column (${dialect})`, () => {
    const cleanups: Array<() => Promise<void> | void> = []

    afterAll(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    })

    async function open(target: string, readOnly = false) {
      const store = createCommandStore(kernelConfig(dialect), {
        ...storageFor(dialect, target),
        ...(readOnly && { readOnly: true }),
      })
      cleanups.push(() => store.close())
      const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
      return { store, repos }
    }

    it('AC-5: a database at 0007 with events written by the old code, migrated to 0008, has correlation_id backfilled from each envelope (else the row id), and queryByCorrelation returns each id’s old rows in seq order', async () => {
      const db = await fresh()
      cleanups.push(() => db.drop())
      const before = migrationsTo0007(dialect)
      cleanups.push(() => before.drop())
      await migrate(dialect, db.target, before.root)

      const a = `legacy-a-${randomUUID()}`
      const b = `legacy-b-${randomUUID()}`
      const event = (correlationId?: string) =>
        makeEvent(
          'ac5.legacy.v1',
          { n: randomUUID() },
          correlationId === undefined ? {} : { correlationId },
        ) as unknown as Record<string, unknown> & { id: string; type: string }
      const own = event()
      const missing = event()
      delete missing['correlationId']
      const legacy = [event(a), event(b), event(a), own, event(b), event(a), missing]
      await insertLegacy(dialect, db.target, legacy)

      await migrate(dialect, db.target, MIGRATIONS_ROOT)

      const raw: RawReader = openRaw(dialect, db.target)
      cleanups.push(() => raw.close())
      const rows = await raw.rows<{
        seq: number | string
        id: string
        correlation_id: string
        envelope: string | Record<string, unknown>
      }>('SELECT seq, id, correlation_id, envelope FROM events ORDER BY seq')
      const envelopeOf = (row: (typeof rows)[number]) =>
        typeof row.envelope === 'string'
          ? (JSON.parse(row.envelope) as Record<string, unknown>)
          : row.envelope
      expect(rows.map((row) => row.id)).toEqual(legacy.map((e) => e.id))
      expect(
        rows.map((row) => row.correlation_id),
        'correlation_id = the envelope’s correlationId, else the row id',
      ).toEqual(
        rows.map((row) => (envelopeOf(row)['correlationId'] as string | undefined) ?? row.id),
      )

      const { store, repos } = await open(db.target)
      const seqOf = new Map(rows.map((row) => [row.id, Number(row.seq)]))
      for (const id of [a, b, own.id, missing.id]) {
        const expected = legacy.filter((e) => (e['correlationId'] ?? e.id) === id).map((e) => e.id)
        const got = await query(store, repos, id)
        expect(
          got.map((row) => row.event.id),
          `queryByCorrelation(${id})`,
        ).toEqual(expected)
        expect(got.map((row) => row.seq)).toEqual(expected.map((eventId) => seqOf.get(eventId)))
      }
    }, 60_000)

    describe('on a migrated database', () => {
      let target: string
      let store: CommandStore
      let repos: Repositories

      beforeAll(async () => {
        const db = await fresh()
        cleanups.push(() => db.drop())
        target = db.target
        await migrate(dialect, target, MIGRATIONS_ROOT)
        ;({ store, repos } = await open(target))
      }, 60_000)

      it('AC-5: property: for any appended envelopes and any types filter, queryByCorrelation(c) equals the envelopes with correlationId c whose type matches a glob, in seq order', async () => {
        // `_` and `%` are LIKE's metacharacters on Postgres and must match only themselves; `*` matches any run.
        const typeArb = fc
          .string({ unit: fc.constantFrom('a', '_', '%', '.'), minLength: 1, maxLength: 3 })
          .map((t) => `ac5.${t}`)
        const globArb = fc.oneof(
          fc.constant('*'),
          fc
            .string({ unit: fc.constantFrom('a', '_', '%', '.', '*'), maxLength: 4 })
            .map((g) => `ac5.${g}`),
        )
        const globMatches = (glob: string, type: string) =>
          new RegExp(
            `^${glob
              .split('*')
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('.*')}$`,
            's',
          ).test(type)
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.tuple(fc.nat({ max: 3 }), typeArb), { minLength: 1, maxLength: 14 }),
            fc.option(fc.array(globArb, { minLength: 1, maxLength: 3 }), { nil: undefined }),
            async (picks, types) => {
              const run = randomUUID()
              const pool = [0, 1, 2, 3].map((k) => `ac5-${run}-${k}`)
              const envelopes = picks.map(([k, type], i) =>
                makeEvent(type, { k, i }, { correlationId: pool[k]! }),
              ) as NymbalEvent<unknown>[]
              await store.transaction((tx) => repos.eventLog.append(tx, envelopes))

              for (const id of pool) {
                const got = await query(store, repos, id, types)
                expect(
                  got.map((row) => row.event),
                  `types ${JSON.stringify(types)}`,
                ).toEqual(
                  envelopes.filter(
                    (e) =>
                      e.correlationId === id &&
                      (types === undefined || types.some((glob) => globMatches(glob, e.type))),
                  ),
                )
                expect(got.map((row) => row.seq)).toEqual(
                  got.map((row) => row.seq).sort((x, y) => x - y),
                )
                expect(new Set(got.map((row) => row.seq)).size).toBe(got.length)
              }
            },
          ),
          { numRuns: 40, endOnFailure: true },
        )
      }, 60_000)

      it('AC-6: through the read-only opener the log answers queryByCorrelation, and append rejects and leaves the log unchanged', async () => {
        const id = `ac6-ro-${randomUUID()}`
        const written = [0, 1, 2].map(
          (i) => makeEvent('ac6.readonly.v1', { i }, { correlationId: id }) as NymbalEvent<unknown>,
        )
        await store.transaction((tx) => repos.eventLog.append(tx, written))
        const ro = await open(target, true)
        const countAll = () =>
          ro.store.read(async (tx) => (await ro.repos.eventLog.listAll(tx)).length)
        const before = await countAll()

        const read = await query(ro.store, ro.repos, id)
        expect(read.map((row) => row.event.id)).toEqual(written.map((e) => e.id))

        const attempt = makeEvent('ac6.readonly.v1', { i: 3 }, { correlationId: id })
        await expect(
          ro.store.transaction((tx) => ro.repos.eventLog.append(tx, [attempt])),
        ).rejects.toThrow()
        expect(await countAll()).toBe(before)
        expect((await query(store, repos, id)).map((row) => row.event.id)).toEqual(
          written.map((e) => e.id),
        )
      })
    })
  })
}
