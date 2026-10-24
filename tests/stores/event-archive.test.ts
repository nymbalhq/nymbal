import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalEvent } from '../../packages/types/src/events/envelope.js'
import { createS3ObjectWriter } from '../../packages/media-s3/src/index.js'
import {
  createCommandStore,
  type CommandStore,
} from '../../packages/platform/src/db/command-store.js'
import { runMigrations } from '../../packages/platform/src/db/migrate.js'
import { InMemoryDocumentStore } from '../../packages/platform/src/document-store/in-memory.js'
import { createEventBuilder } from '../../packages/platform/src/events/builder.js'
import { createLogger } from '../../packages/platform/src/logger.js'
import {
  buildRepositories,
  type Repositories,
} from '../../packages/platform/src/repositories/index.js'
import { startEventRetentionSweeper } from '../../packages/platform/src/sweepers/index.js'
import { TEST_BUILDER_CONTEXT } from '../../packages/platform/src/tests/publisher.js'
import {
  kernelConfig,
  MIGRATIONS_ROOT,
  type Dialect,
} from '../../packages/platform/tests/support/kernel.js'
import {
  createdAtById,
  presentIds,
  setCreatedAt,
} from '../../packages/platform/tests/support/created-at.js'
import {
  createDatabase,
  postgresServerUrl,
} from '../../packages/platform/tests/support/postgres.js'
import {
  anonymousGet,
  createPrivateBucket,
  S3_TEST_REGION,
  s3Credentials,
  type TestBucket,
} from '../support/s3'

// AC-8 and AC-9, the archive, on SQLite and Postgres with MinIO (NYMBAL_TEST_S3_ENDPOINT, NYMBAL_TEST_POSTGRES_URL).
// The retention sweeper is given an object writer as `archive`: createS3ObjectWriter on a private bucket this run
// makes (no anonymous download), or an in-memory double that fails, or that keeps the object and then loses the
// answer. Rows are dated through the repositories' `at` arguments (markDelivered, recordFailure), and `created_at` is
// set beside them by a second connection, so each row's age is what the case says. The sweeper hands the writer
// `events/<yyyy>/<mm>/<dd>/<first>-<last>.ndjson.gz` (dated in UTC by the first row's created_at) and the writer puts
// it under its prefix.
// AC-8, property: after a sweep every deleted row is in an archived object under its date key, its line equal to the
// parsed envelope plus seq and deliveredAt; exactly the delivered rows older than the cutoff are deleted, and no
// undelivered or dead row; retentionDays 7 or 30 moves the cutoff. A failed put deletes nothing and the next sweep
// archives the same batch; so does a put whose answer is lost, and deduping by seq gives each row once. AC-9: what
// createS3ObjectWriter writes is not readable anonymously (403). Without an archive the sweeper only deletes:
// packages/platform/tests/integration/event-retention.test.ts.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const KEY = /(?:^|\/)events\/(\d{4})\/(\d{2})\/(\d{2})\/(\d+)-(\d+)\.ndjson\.gz$/

type Kind = 'delivered' | 'undelivered' | 'dead'

interface ObjectWriter {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
}

interface Snapshot {
  seq: number
  id: string
  kind: Kind
  envelope: Record<string, unknown>
  deliveredAt: Date | null
  createdAt: Date
}

interface Archived {
  key: string
  firstSeq: number
  lastSeq: number
  date: string
  lines: Array<Record<string, unknown>>
}

const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)
const logger = createLogger({ pretty: false, level: 'error' })

function parseObject(key: string, body: Uint8Array): Archived {
  const m = KEY.exec(key)
  expect(m, `object key ${key}`).not.toBeNull()
  const lines = gunzipSync(body)
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return {
    key,
    firstSeq: Number(m![4]),
    lastSeq: Number(m![5]),
    date: `${m![1]}-${m![2]}-${m![3]}`,
    lines,
  }
}

/** A writer that keeps what it is given in memory, by the key it was handed. */
function memoryWriter(): { writer: ObjectWriter; archived(): Archived[] } {
  const objects = new Map<string, Uint8Array>()
  return {
    writer: {
      async put(key, body) {
        objects.set(key, new Uint8Array(body))
      },
    },
    archived: () => [...objects].map(([key, body]) => parseObject(key, body)),
  }
}

/** The archived lines, deduped by seq; every copy of a seq must be the same line. */
function bySeq(objects: Archived[]): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>()
  for (const object of objects) {
    for (const line of object.lines) {
      const seq = Number(line['seq'])
      if (out.has(seq)) expect(line, `seq ${seq} archived twice, differently`).toEqual(out.get(seq))
      out.set(seq, line)
    }
  }
  return out
}

/** An archive line, compared with the row it came from. */
function expectLineOf(row: Snapshot, line: Record<string, unknown> | undefined): void {
  expect(line, `seq ${row.seq} (${row.kind}) is in no archived object`).toBeDefined()
  const { seq, deliveredAt, ...envelope } = line!
  expect(envelope, `seq ${row.seq}: the envelope`).toEqual(row.envelope)
  expect(seq).toBe(row.seq)
  expect(new Date(String(deliveredAt)).getTime()).toBe(row.deliveredAt!.getTime())
}

/** Each object holds its key's seq range in order, at most 5000 lines, dated by its first row's created_at (UTC). */
function expectWellFormed(objects: Archived[], rows: Map<number, Snapshot>): void {
  for (const object of objects) {
    const seqs = object.lines.map((l) => Number(l['seq']))
    expect(seqs.length, object.key).toBeGreaterThan(0)
    expect(seqs.length, object.key).toBeLessThanOrEqual(5000)
    expect([seqs[0], seqs[seqs.length - 1]], object.key).toEqual([object.firstSeq, object.lastSeq])
    expect(
      seqs.every((s, i) => i === 0 || s > seqs[i - 1]!),
      `${object.key}: seq order`,
    ).toBe(true)
    const first = rows.get(object.firstSeq)
    expect(first, `${object.key}: its first row`).toBeDefined()
    expect(object.date, `${object.key}: dated by its first row`).toBe(
      first!.createdAt.toISOString().slice(0, 10),
    )
  }
}

const dialects: Dialect[] = ['sqlite', 'postgres']

describe.each(dialects)('AC-8: archive before delete (%s)', (dialect) => {
  let store: CommandStore
  let repos: Repositories
  let target: string
  let bucket: TestBucket
  const cleanups: Array<() => Promise<void> | void> = []

  beforeAll(async () => {
    if (dialect === 'sqlite') {
      const dir = mkdtempSync(join(tmpdir(), 'events-archive-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      target = join(dir, 'store.sqlite')
    } else {
      const db = await createDatabase(postgresServerUrl(), 'p301_archive')
      cleanups.push(() => db.drop())
      target = db.url
    }
    const config = kernelConfig(dialect)
    store = createCommandStore(
      config,
      dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target },
    )
    cleanups.push(() => store.close())
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
    repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    bucket = await createPrivateBucket(`archive-${dialect}`)
    cleanups.push(() => bucket.remove())
  }, 60_000)

  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
  })

  function s3Writer(prefix: string): ObjectWriter {
    return createS3ObjectWriter({
      bucket: bucket.name,
      prefix,
      region: S3_TEST_REGION,
      endpoint: bucket.endpoint,
      forcePathStyle: true,
      credentials: s3Credentials(),
    })
  }

  /** Every object under `prefix`, parsed. */
  async function archivedUnder(prefix: string): Promise<Archived[]> {
    const keys = (await bucket.keys()).filter((k) => k.startsWith(prefix))
    const out: Archived[] = []
    for (const key of keys) {
      const got = await bucket.getObject(key)
      expect(got.status, key).toBe(200)
      out.push(parseObject(key, got.bytes))
    }
    return out
  }

  /** Appends one event per spec, dates it, and answers the rows as the log holds them. */
  async function seed(
    specs: Array<{ kind: Kind; ageMs: number }>,
    now: number,
  ): Promise<Snapshot[]> {
    const events = specs.map(
      (_, i) =>
        makeEvent(
          'ac8.archive.v1',
          { i, tag: randomUUID() },
          { correlationId: `ac8:${randomUUID()}` },
        ) as NymbalEvent<unknown>,
    )
    await store.transaction(async (tx) => {
      await repos.eventLog.append(tx, events)
      for (const [i, spec] of specs.entries()) {
        const at = new Date(now - spec.ageMs)
        if (spec.kind === 'delivered') await repos.eventLog.markDelivered(tx, [events[i]!.id], at)
        if (spec.kind === 'dead') await repos.eventLog.recordFailure(tx, events[i]!.id, at, 1)
      }
    })
    // Created a minute before the age the row is given, so delivery follows creation.
    const createdAt = new Map(
      events.map((e, i) => [e.id, new Date(now - specs[i]!.ageMs - 60_000)]),
    )
    await setCreatedAt(dialect, target, createdAt)
    const ids = new Set(events.map((e) => e.id))
    const logged = (await store.read((tx) => repos.eventLog.listAll(tx))).filter((row) =>
      ids.has(row.event.id),
    )
    return logged.map((row) => {
      const i = events.findIndex((e) => e.id === row.event.id)
      return {
        seq: row.seq,
        id: row.event.id,
        kind: specs[i]!.kind,
        envelope: row.event as unknown as Record<string, unknown>,
        deliveredAt: row.deliveredAt,
        createdAt: createdAt.get(row.event.id)!,
      }
    })
  }

  /** Every row of the log as it stands, with its kind and created_at. */
  async function snapshotAll(): Promise<Snapshot[]> {
    const logged = await store.read((tx) => repos.eventLog.listAll(tx))
    const created = await createdAtById(dialect, target)
    return logged.map((row) => ({
      seq: row.seq,
      id: row.event.id,
      kind: row.deadAt !== null ? 'dead' : row.deliveredAt !== null ? 'delivered' : 'undelivered',
      envelope: row.event as unknown as Record<string, unknown>,
      deliveredAt: row.deliveredAt,
      createdAt: created.get(row.event.id)!,
    }))
  }

  function present(ids: string[]): Promise<Set<string>> {
    return presentIds(dialect, target, ids)
  }

  function sweeper(archive: ObjectWriter, retentionDays: number) {
    return startEventRetentionSweeper({
      store,
      eventLog: repos.eventLog,
      processedEvents: repos.processedEvent,
      logger,
      retentionDays,
      intervalMs: 3_600_000,
      archive,
    })
  }

  it('AC-8: property (logs of delivered, undelivered and dead rows aged either side of a 7- or 30-day cutoff, MinIO): a sweep deletes exactly the delivered rows past the cutoff, each one first archived under its date key as its envelope plus seq and deliveredAt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(7, 30),
        fc.array(
          fc.record({
            kind: fc.constantFrom<Kind>('delivered', 'undelivered', 'dead'),
            older: fc.boolean(),
            hours: fc.integer({ min: 2, max: 150 }),
          }),
          { minLength: 1, maxLength: 14 },
        ),
        async (retentionDays, specs) => {
          const now = Date.now()
          await seed(
            specs.map((s) => ({
              kind: s.kind,
              ageMs: retentionDays * DAY_MS + (s.older ? 1 : -1) * s.hours * HOUR_MS,
            })),
            now,
          )
          // The whole log: rows earlier runs kept may fall past this run's cutoff.
          const before = await snapshotAll()
          const cutoff = now - retentionDays * DAY_MS
          const prefix = `run-${randomUUID()}/`
          const sweep = sweeper(s3Writer(prefix), retentionDays)
          try {
            await sweep.tick()
          } finally {
            sweep.stop()
          }

          const left = await present(before.map((r) => r.id))
          expect(
            before.map((r) => !left.has(r.id)),
            'deleted = delivered before the cutoff, and nothing else',
          ).toEqual(before.map((r) => r.kind === 'delivered' && r.deliveredAt!.getTime() < cutoff))

          const objects = await archivedUnder(prefix)
          expectWellFormed(objects, new Map(before.map((r) => [r.seq, r])))
          const lines = bySeq(objects)
          for (const row of before.filter((r) => !left.has(r.id))) {
            expectLineOf(row, lines.get(row.seq))
          }
          expect(
            before.filter((r) => left.has(r.id) && lines.has(r.seq)).map((r) => r.seq),
            'kept rows archived',
          ).toEqual([])
        },
      ),
      { numRuns: 6, endOnFailure: true },
    )
  }, 180_000)

  it('AC-8: a put that fails (a writer double) deletes nothing; the next sweep archives the same batch (lastSeq unchanged, though newer rows are due) and only then deletes it', async () => {
    const now = Date.now()
    const old = 31 * DAY_MS
    const first = await seed(
      [
        { kind: 'delivered', ageMs: old },
        { kind: 'delivered', ageMs: old },
        { kind: 'dead', ageMs: old },
      ],
      now,
    )
    const real = memoryWriter()
    const attempts: string[] = []
    let failing = true
    const sweep = sweeper(
      {
        async put(key, body, contentType) {
          attempts.push(key)
          if (failing) throw new Error('archive unavailable')
          await real.writer.put(key, body, contentType)
        },
      },
      30,
    )
    try {
      await sweep.tick()
      expect(await present(first.map((r) => r.id)), 'rows after a failed put').toEqual(
        new Set(first.map((r) => r.id)),
      )
      expect(attempts.length, 'the failed sweep tried a put').toBeGreaterThan(0)
      const failedKey = attempts[0]!

      const later = await seed([{ kind: 'delivered', ageMs: old }], now)
      failing = false
      const tried = attempts.length
      await sweep.tick()
      await sweep.tick()

      expect(attempts[tried], 'the retry is the batch that failed').toBe(failedKey)
      const all = [...first, ...later]
      const left = await present(all.map((r) => r.id))
      expect(all.map((r) => left.has(r.id))).toEqual(all.map((r) => r.kind === 'dead'))
      const lines = bySeq(real.archived())
      for (const row of all.filter((r) => r.kind === 'delivered'))
        expectLineOf(row, lines.get(row.seq))
    } finally {
      sweep.stop()
    }
  }, 60_000)

  it('AC-8: a put that stores the object but whose answer is lost (a writer double) leaves the rows; the next sweep re-archives the same batch, and deduping by seq gives each row once', async () => {
    const now = Date.now()
    const old = 40 * DAY_MS
    const first = await seed(
      [
        { kind: 'delivered', ageMs: old },
        { kind: 'undelivered', ageMs: old },
        { kind: 'delivered', ageMs: old },
      ],
      now,
    )
    const real = memoryWriter()
    const attempts: string[] = []
    let lose = true
    const sweep = sweeper(
      {
        async put(key, body, contentType) {
          attempts.push(key)
          await real.writer.put(key, body, contentType)
          if (lose) throw new Error('socket hang up')
        },
      },
      30,
    )
    try {
      await sweep.tick()
      expect(await present(first.map((r) => r.id)), 'rows after a lost answer').toEqual(
        new Set(first.map((r) => r.id)),
      )
      const lostKey = attempts[0]!
      expect(KEY.test(lostKey), lostKey).toBe(true)

      const later = await seed([{ kind: 'delivered', ageMs: old }], now)
      lose = false
      const tried = attempts.length
      await sweep.tick()
      await sweep.tick()

      expect(attempts[tried], 'the retry is the same batch').toBe(lostKey)
      const all = [...first, ...later]
      const left = await present(all.map((r) => r.id))
      expect(all.map((r) => left.has(r.id))).toEqual(all.map((r) => r.kind === 'undelivered'))
      const lines = bySeq(real.archived())
      const delivered = all.filter((r) => r.kind === 'delivered')
      for (const row of delivered) expectLineOf(row, lines.get(row.seq))
      expect([...lines.keys()].sort((a, b) => a - b)).toEqual(
        delivered.map((r) => r.seq).sort((a, b) => a - b),
      )
    } finally {
      sweep.stop()
    }
  }, 60_000)
})

describe('AC-9: archives are private', () => {
  let bucket: TestBucket

  beforeAll(async () => {
    bucket = await createPrivateBucket('archive-private')
  })

  afterAll(async () => {
    await bucket?.remove()
  })

  it('AC-9: an object createS3ObjectWriter puts in a bucket made without anonymous download is readable signed, and an HTTP GET without credentials gets 403', async () => {
    const writer = createS3ObjectWriter({
      bucket: bucket.name,
      prefix: 'private/',
      region: S3_TEST_REGION,
      endpoint: bucket.endpoint,
      forcePathStyle: true,
      credentials: s3Credentials(),
    })
    const body = new TextEncoder().encode(`{"seq":1,"tag":"${randomUUID()}"}\n`)
    await writer.put('events/2026/10/21/1-1.ndjson.gz', body, 'application/gzip')

    const keys = await bucket.keys()
    expect(keys.length).toBe(1)
    const signed = await bucket.getObject(keys[0]!)
    expect([signed.status, Buffer.from(signed.bytes).equals(Buffer.from(body))]).toEqual([
      200,
      true,
    ])
    const anonymous = await anonymousGet(`${bucket.url}/${keys[0]!}`)
    expect(anonymous.status).toBe(403)
  })
})
