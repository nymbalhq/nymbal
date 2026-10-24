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
import type { LoggedEvent } from '../../../src/repositories/event-log.js'
import { TEST_BUILDER_CONTEXT } from '../../../src/tests/publisher.js'
import { kernelConfig, MIGRATIONS_ROOT, type Dialect } from '../kernel.js'
import { openRaw } from '../raw.js'

// AC-4 on one dialect: the subject columns. `append` sets `events.subject_type` and `events.subject_id` from
// `subjectOf(envelope)` for every row of the subject table (and null for anything else); migration 0012, run on a
// store at 0011 holding rows of every kind, backfills the same values; and `listBySubjects` returns exactly the rows
// of the subjects it is given, in seq order, paged by `afterSeq` and `limit`. The expected subject is this file's own
// reading of the table, and `subjectOf` must agree with it.

const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

type Subject = { type: string; id: string } | null

interface Sample {
  type: string
  payload: Record<string, unknown>
  subject: Subject
}

/** One envelope of each shape the subject table names, about `id`, with the subject the table gives it. */
function samplesFor(id: string): Sample[] {
  const product = { type: 'product', id }
  const order = { type: 'order', id }
  return [
    { type: 'product.created.v1', payload: { product: { id, slug: 's' } }, subject: product },
    { type: 'product.updated.v1', payload: { product: { id, slug: 's' } }, subject: product },
    { type: 'product.deleted.v1', payload: { productId: id, slug: 's' }, subject: product },
    { type: 'product.published.v1', payload: { productId: id, slug: 's' }, subject: product },
    { type: 'order.placed.v1', payload: { order: { id, orderNumber: 'N' } }, subject: order },
    { type: 'order.paid.v1', payload: { orderId: id, amountMinor: 1 }, subject: order },
    {
      type: 'order.status_changed.v1',
      payload: { orderId: id, from: 'a', to: 'b' },
      subject: order,
    },
    {
      type: 'order.partially_refunded.v1',
      payload: { orderId: id, refundId: 'r' },
      subject: order,
    },
    {
      type: 'payment.intent_created.v1',
      payload: { paymentId: 'pi', orderId: id },
      subject: order,
    },
    { type: 'payment.captured.v1', payload: { paymentId: 'pi', orderId: id }, subject: order },
    {
      type: 'customer.created.v1',
      payload: { customerId: id, email: 'a@b.test' },
      subject: { type: 'customer', id },
    },
    { type: 'customer.updated.v1', payload: { customerId: id }, subject: { type: 'customer', id } },
    {
      type: 'inventory.changed.v1',
      payload: { variantId: id, previousQty: 2, newQty: 1, reason: 'manual' },
      subject: { type: 'variant', id },
    },
    {
      type: 'inventory.reserved.v1',
      payload: { variantId: id, qty: 1 },
      subject: { type: 'variant', id },
    },
    { type: 'cart.updated.v1', payload: { cartId: id, itemCount: 0 }, subject: null },
    { type: 'category.created.v1', payload: { category: { id } }, subject: null },
    { type: 'review.created.v1', payload: { reviewId: id, productId: id }, subject: null },
  ]
}

function envelopeOf(sample: Sample): NymbalEvent<unknown> {
  return makeEvent(sample.type, sample.payload) as NymbalEvent<unknown>
}

function storageFor(dialect: Dialect, target: string) {
  return dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
}

/** A copy of the migrations for `dialect` holding 0000-0011 only: the schema before the migration under test. */
function migrationsTo0011(dialect: Dialect): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'history-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 11)
  if (journal.entries.length !== 12) throw new Error(`expected migrations 0000-0011 in ${from}`)
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

/** Inserts rows the way the code before 0012 did: the 0011 columns, no subject. */
async function insertLegacy(
  dialect: Dialect,
  target: string,
  envelopes: NymbalEvent<unknown>[],
): Promise<void> {
  const createdAt = new Date().toISOString()
  if (dialect === 'sqlite') {
    const db = new Database(target)
    try {
      const insert = db.prepare(
        'INSERT INTO events (id, type, envelope, correlation_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      for (const e of envelopes) {
        insert.run(e.id, e.type, JSON.stringify(e), e.correlationId, createdAt)
      }
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
        'INSERT INTO events (id, type, envelope, correlation_id, created_at) VALUES ($1, $2, $3::jsonb, $4, $5)',
        [e.id, e.type, JSON.stringify(e), e.correlationId, createdAt],
      )
    }
  } finally {
    await client.end()
  }
}

interface SubjectRow {
  id: string
  seq: number | string
  subject_type: string | null
  subject_id: string | null
}

const asSubject = (row: SubjectRow): Subject =>
  row.subject_type === null && row.subject_id === null
    ? null
    : { type: String(row.subject_type), id: String(row.subject_id) }

interface ListBySubjects {
  listBySubjects(
    tx: unknown,
    subjects: Array<{ type: string; id: string }>,
    page: { until?: Date; afterSeq?: number; limit: number },
  ): Promise<LoggedEvent[]>
}

function listBy(
  store: CommandStore,
  repos: Repositories,
  subjects: Array<{ type: string; id: string }>,
  page: { afterSeq?: number; limit: number } = { limit: 10_000 },
): Promise<LoggedEvent[]> {
  const log = repos.eventLog as unknown as ListBySubjects
  return store.read((tx) => log.listBySubjects(tx, subjects, page))
}

export function eventSubjectSuite(
  dialect: Dialect,
  /** A fresh, empty database: its target and how to drop it. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`AC-4: the subject columns (${dialect})`, () => {
    const cleanups: Array<() => Promise<void> | void> = []

    afterAll(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    })

    async function open(target: string) {
      const store = createCommandStore(kernelConfig(dialect), storageFor(dialect, target))
      cleanups.push(() => store.close())
      const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
      return { store, repos }
    }

    async function subjectColumns(target: string, ids: string[]): Promise<Map<string, Subject>> {
      const raw = openRaw(dialect, target)
      try {
        const rows = await raw.rows<SubjectRow>(
          'SELECT id, seq, subject_type, subject_id FROM events ORDER BY seq',
        )
        const wanted = new Set(ids)
        return new Map(rows.filter((r) => wanted.has(r.id)).map((r) => [r.id, asSubject(r)]))
      } finally {
        await raw.close()
      }
    }

    it('AC-4: migration 0012 on a store at 0011 holding rows of every kind backfills subject_type and subject_id as the subject table gives them, and listBySubjects returns one subject’s rows in seq order', async () => {
      const db = await fresh()
      cleanups.push(() => db.drop())
      const before = migrationsTo0011(dialect)
      cleanups.push(() => before.drop())
      await migrate(dialect, db.target, before.root)

      const a = randomUUID()
      const b = randomUUID()
      const samples = [...samplesFor(a), ...samplesFor(b)]
      // Interleaved, so a subject's rows are not one run of seqs.
      const order = samples.map((_, i) => i).sort((x, y) => (x % 2) - (y % 2) || x - y)
      const legacy = order.map((i) => ({ sample: samples[i]!, envelope: envelopeOf(samples[i]!) }))
      await insertLegacy(
        dialect,
        db.target,
        legacy.map((l) => l.envelope),
      )

      await migrate(dialect, db.target, MIGRATIONS_ROOT)

      const columns = await subjectColumns(
        db.target,
        legacy.map((l) => l.envelope.id),
      )
      expect(
        legacy.map((l) => [l.envelope.type, columns.get(l.envelope.id)]),
        'backfilled subject per row',
      ).toEqual(legacy.map((l) => [l.envelope.type, l.sample.subject]))

      const { store, repos } = await open(db.target)
      for (const subject of [
        { type: 'order', id: a },
        { type: 'product', id: b },
        { type: 'variant', id: a },
      ]) {
        const expected = legacy
          .filter(
            (l) => l.sample.subject?.type === subject.type && l.sample.subject.id === subject.id,
          )
          .map((l) => l.envelope.id)
        const got = await listBy(store, repos, [subject])
        expect(
          got.map((row) => row.event.id),
          `listBySubjects(${subject.type} ${subject.id})`,
        ).toEqual(expected)
        expect(expected.length).toBeGreaterThan(0)
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

      it('AC-4: append sets subject_type and subject_id for every row of the subject table, null for anything else, and subjectOf agrees', async () => {
        const id = randomUUID()
        const samples = samplesFor(id)
        const envelopes = samples.map(envelopeOf)
        await store.transaction((tx) => repos.eventLog.append(tx, envelopes))

        const columns = await subjectColumns(
          target,
          envelopes.map((e) => e.id),
        )
        expect(
          envelopes.map((e) => [e.type, columns.get(e.id)]),
          'appended subject per row',
        ).toEqual(samples.map((s) => [s.type, s.subject]))

        const { subjectOf } = await import('../../../src/history/index.js')
        expect(
          envelopes.map((e) => [e.type, subjectOf(e)]),
          'subjectOf per envelope',
        ).toEqual(samples.map((s) => [s.type, s.subject]))
      })

      it('AC-4: property: for appended envelopes over a pool of subjects, listBySubjects(S) is exactly the rows whose subject is in S, in seq order, and afterSeq and limit page through them without overlap', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.tuple(fc.nat({ max: 16 }), fc.nat({ max: 2 })), {
              minLength: 1,
              maxLength: 24,
            }),
            fc.subarray([0, 1, 2], { minLength: 1 }),
            fc.integer({ min: 1, max: 5 }),
            async (picks, chosen, limit) => {
              const pool = [randomUUID(), randomUUID(), randomUUID()]
              const written = picks.map(([shape, who]) => samplesFor(pool[who]!)[shape]!)
              const envelopes = written.map(envelopeOf)
              await store.transaction((tx) => repos.eventLog.append(tx, envelopes))

              const subjects = [
                ...new Map(
                  written
                    .filter((s, i) => s.subject !== null && chosen.includes(picks[i]![1]))
                    .map((s) => [`${s.subject!.type}:${s.subject!.id}`, s.subject!]),
                ).values(),
              ]
              if (subjects.length === 0) return
              const key = (s: Subject) => (s === null ? '' : `${s.type}:${s.id}`)
              const inSet = new Set(subjects.map(key))
              const expected = envelopes
                .filter((_, i) => inSet.has(key(written[i]!.subject)))
                .map((e) => e.id)

              const all = await listBy(store, repos, subjects)
              expect(all.map((row) => row.event.id)).toEqual(expected)
              const seqs = all.map((row) => row.seq)
              expect(seqs).toEqual([...seqs].sort((x, y) => x - y))

              const paged: string[] = []
              let afterSeq: number | undefined
              for (let page = 0; page <= expected.length; page += 1) {
                const rows = await listBy(store, repos, subjects, {
                  limit,
                  ...(afterSeq !== undefined && { afterSeq }),
                })
                expect(rows.length).toBeLessThanOrEqual(limit)
                if (rows.length === 0) break
                paged.push(...rows.map((row) => row.event.id))
                afterSeq = rows[rows.length - 1]!.seq
              }
              expect(paged).toEqual(expected)
            },
          ),
          { numRuns: 30, endOnFailure: true },
        )
      }, 60_000)
    })
  })
}
