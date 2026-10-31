import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { NymbalEvent } from '@nymbalhq/types'
import {
  postgresDb,
  sqliteDb,
  type CommandStore,
  type ReadTx,
  type StoreRepository,
  type Tx,
} from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import { subjectOf, type EventSubject } from '../history/subject.js'

export interface LoggedEvent {
  seq: number
  event: NymbalEvent<unknown>
  deliveredAt: Date | null
  attempts: number
  deadAt: Date | null
  createdAt: Date
}

/** Filters for reading the log. A type glob's `*` matches any run of characters, dots included (`order.*`). */
export interface EventLogFilter {
  /** Type globs; an event matches when its type matches any of them. */
  types?: string[]
  /** Appended at or after. */
  since?: Date
  /** Appended before. */
  until?: Date
  limit: number
}

export interface EventLogRepository extends StoreRepository {
  /** Appends in array order, so `seq` follows publish order. */
  append(tx: Tx, events: NymbalEvent<unknown>[]): Promise<void>
  /**
   * Neither delivered nor dead, by `seq`; `afterSeq` pages through one pass without re-reading rows it just tried.
   * Given `now`, a row whose `retry_at` is after it is left out.
   */
  listUndelivered(tx: ReadTx, limit: number, afterSeq?: number, now?: Date): Promise<LoggedEvent[]>
  markDelivered(tx: Tx, ids: string[], at: Date): Promise<void>
  /**
   * One more failed attempt; the event is dead (`dead_at = at`) once its attempts reach `maxAttempts`. `retryAt`, when
   * given, is the earliest the next attempt may be made.
   */
  recordFailure(tx: Tx, id: string, at: Date, maxAttempts: number, retryAt?: Date): Promise<void>
  /** A delivery that failed during an adapter outage: only the earliest next attempt moves, nothing is counted. */
  recordOutage(tx: Tx, id: string, retryAt: Date): Promise<void>
  countDead(tx: ReadTx): Promise<number>
  /** Dead events, oldest first. */
  listDead(tx: ReadTx, limit: number): Promise<LoggedEvent[]>
  /** Neither delivered nor dead, with at least one failed attempt. */
  countRetrying(tx: ReadTx): Promise<number>
  /** Deletes delivered events delivered before `at`; returns how many. Undelivered and dead events are never deleted. */
  deleteDeliveredBefore(tx: Tx, at: Date): Promise<number>
  listAll(tx: ReadTx): Promise<LoggedEvent[]>
  /** One correlation id's events, by `seq`. */
  queryByCorrelation(
    tx: ReadTx,
    correlationId: string,
    filter: EventLogFilter,
  ): Promise<LoggedEvent[]>
  /** Events above `seq`, by `seq`. */
  listAfter(
    tx: ReadTx,
    seq: number,
    filter: Pick<EventLogFilter, 'types' | 'limit'>,
  ): Promise<LoggedEvent[]>
  /** The highest `seq` in the log, or 0 when it is empty. */
  maxSeq(tx: ReadTx): Promise<number>
  /**
   * What a read-model rebuild re-applies after its swap: every event that is not dead and was delivered at or after
   * `since`, or not yet delivered, by `seq`. `afterSeq` and `limit` page through them.
   */
  listForCatchUp(
    tx: ReadTx,
    since: Date,
    page?: { afterSeq?: number; limit?: number },
  ): Promise<LoggedEvent[]>
  /** Delivered events delivered before `at`, by `seq`: what retention may archive. Undelivered and dead events never are. */
  listDeliveredBefore(tx: ReadTx, at: Date, limit: number): Promise<LoggedEvent[]>
  /** Deletes the delivered events with these `seq`s; returns how many. */
  deleteSeqs(tx: Tx, seqs: number[]): Promise<number>
  /**
   * The events whose subject is one of `subjects`, by `seq`: those appended at or before `until`, above `afterSeq`, at
   * most `limit`.
   */
  listBySubjects(
    tx: ReadTx,
    subjects: EventSubject[],
    page: { until?: Date; afterSeq?: number; limit: number },
  ): Promise<LoggedEvent[]>
}

// SQLite's bound-parameter limit is per statement; seven columns a row keep a chunk well under it.
const APPEND_CHUNK = 100
const DELETE_CHUNK = 500
const APPEND_INTO =
  'INSERT INTO events (id, type, envelope, correlation_id, subject_type, subject_id, created_at) VALUES'
/** The page `listForCatchUp` reads when it is given none. */
const CATCH_UP_LIMIT = 10_000

/** A type glob as a SQLite GLOB pattern: `*` stays the wildcard, and GLOB's other metacharacters match themselves. */
function sqliteGlob(glob: string): string {
  return glob.replace(/[[?]/g, (c) => `[${c}]`)
}

/**
 * A type glob as a Postgres LIKE pattern with a backslash escape: `*` is `%`, and LIKE's own metacharacters match
 * themselves. Case-sensitive, as SQLite's GLOB is.
 */
function likePattern(glob: string): string {
  return glob.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '%')
}

function subjectColumns(e: NymbalEvent<unknown>): {
  subjectType: string | null
  subjectId: string | null
} {
  const subject = subjectOf(e)
  return { subjectType: subject?.type ?? null, subjectId: subject?.id ?? null }
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(String(value))
}

function rowToLogged(row: {
  seq: number
  envelope: unknown
  deliveredAt: unknown
  attempts: number
  deadAt: unknown
  createdAt: unknown
}): LoggedEvent {
  const envelope =
    typeof row.envelope === 'string'
      ? (JSON.parse(row.envelope) as NymbalEvent<unknown>)
      : (row.envelope as NymbalEvent<unknown>)
  return {
    seq: Number(row.seq),
    event: envelope,
    deliveredAt: toDate(row.deliveredAt),
    attempts: Number(row.attempts),
    deadAt: toDate(row.deadAt),
    createdAt: toDate(row.createdAt)!,
  }
}

export function createEventLogRepository(store: CommandStore): EventLogRepository {
  const s = sqliteSchema.events
  const p = postgresSchema.events
  // The columns `rowToLogged` reads.
  const sqliteLogged = {
    seq: s.seq,
    envelope: s.envelope,
    deliveredAt: s.deliveredAt,
    attempts: s.attempts,
    deadAt: s.deadAt,
    createdAt: s.createdAt,
  }
  const postgresLogged = {
    seq: p.seq,
    envelope: p.envelope,
    deliveredAt: p.deliveredAt,
    attempts: p.attempts,
    deadAt: p.deadAt,
    createdAt: p.createdAt,
  }

  function sqliteWhere(filter: Partial<EventLogFilter>): SQL[] {
    const where: SQL[] = []
    if (filter.types !== undefined && filter.types.length > 0) {
      where.push(or(...filter.types.map((t) => sql`${s.type} GLOB ${sqliteGlob(t)}`))!)
    }
    if (filter.since !== undefined) where.push(gte(s.createdAt, filter.since.toISOString()))
    if (filter.until !== undefined) where.push(lt(s.createdAt, filter.until.toISOString()))
    return where
  }

  function postgresWhere(filter: Partial<EventLogFilter>): SQL[] {
    const where: SQL[] = []
    if (filter.types !== undefined && filter.types.length > 0) {
      where.push(or(...filter.types.map((t) => sql`${p.type} LIKE ${likePattern(t)} ESCAPE '\\'`))!)
    }
    if (filter.since !== undefined) where.push(gte(p.createdAt, filter.since))
    if (filter.until !== undefined) where.push(lt(p.createdAt, filter.until))
    return where
  }

  /** Only the columns a LoggedEvent maps: a boot rebuild reads the log on a store not yet migrated past 0007. */
  async function select(
    tx: ReadTx,
    where: { sqlite: SQL[]; postgres: SQL[] },
    limit: number,
  ): Promise<LoggedEvent[]> {
    if (tx.kind === 'sqlite') {
      return sqliteDb(tx)
        .select(sqliteLogged)
        .from(s)
        .where(and(...where.sqlite))
        .orderBy(asc(s.seq))
        .limit(limit)
        .all()
        .map(rowToLogged)
    }
    const rows = await postgresDb(tx)
      .select(postgresLogged)
      .from(p)
      .where(and(...where.postgres))
      .orderBy(asc(p.seq))
      .limit(limit)
    return rows.map(rowToLogged)
  }

  return {
    store,
    // The columns are named, not taken from the schema: a store a migration behind, before a later column of the log
    // (retry_at), still takes appends.
    async append(tx, events) {
      const now = new Date()
      for (let i = 0; i < events.length; i += APPEND_CHUNK) {
        const chunk = events.slice(i, i + APPEND_CHUNK)
        const rows = (row: (e: NymbalEvent<unknown>) => SQL) => sql.join(chunk.map(row), sql`, `)
        if (tx.kind === 'sqlite') {
          const at = now.toISOString()
          sqliteDb(tx).run(
            sql`${sql.raw(APPEND_INTO)} ${rows((e) => {
              const { subjectType, subjectId } = subjectColumns(e)
              return sql`(${e.id}, ${e.type}, ${JSON.stringify(e)}, ${e.correlationId}, ${subjectType}, ${subjectId}, ${at})`
            })}`,
          )
        } else {
          await postgresDb(tx).execute(
            sql`${sql.raw(APPEND_INTO)} ${rows((e) => {
              const { subjectType, subjectId } = subjectColumns(e)
              return sql`(${e.id}, ${e.type}, ${JSON.stringify(e)}::jsonb, ${e.correlationId}, ${subjectType}, ${subjectId}, ${now.toISOString()}::timestamptz)`
            })}`,
          )
        }
      }
    },
    listUndelivered(tx, limit, afterSeq = 0, now) {
      return select(
        tx,
        {
          sqlite: [
            isNull(s.deliveredAt),
            isNull(s.deadAt),
            gt(s.seq, afterSeq),
            ...(now === undefined
              ? []
              : [or(isNull(s.retryAt), lte(s.retryAt, now.toISOString()))!]),
          ],
          postgres: [
            isNull(p.deliveredAt),
            isNull(p.deadAt),
            gt(p.seq, afterSeq),
            ...(now === undefined ? [] : [or(isNull(p.retryAt), lte(p.retryAt, now))!]),
          ],
        },
        limit,
      )
    },
    async markDelivered(tx, ids, at) {
      if (ids.length === 0) return
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(s)
          .set({ deliveredAt: at.toISOString() })
          .where(inArray(s.id, ids))
          .run()
        return
      }
      await postgresDb(tx).update(p).set({ deliveredAt: at }).where(inArray(p.id, ids))
    },
    async recordFailure(tx, id, at, maxAttempts, retryAt) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(s)
          .set({
            attempts: sql`${s.attempts} + 1`,
            deadAt: sql`CASE WHEN ${s.attempts} + 1 >= ${maxAttempts} THEN ${at.toISOString()} ELSE ${s.deadAt} END`,
            ...(retryAt !== undefined && { retryAt: retryAt.toISOString() }),
          })
          .where(eq(s.id, id))
          .run()
        return
      }
      await postgresDb(tx)
        .update(p)
        .set({
          attempts: sql`${p.attempts} + 1`,
          deadAt: sql`CASE WHEN ${p.attempts} + 1 >= ${maxAttempts} THEN ${at.toISOString()}::timestamptz ELSE ${p.deadAt} END`,
          ...(retryAt !== undefined && { retryAt }),
        })
        .where(eq(p.id, id))
    },
    async recordOutage(tx, id, retryAt) {
      if (tx.kind === 'sqlite') {
        sqliteDb(tx).update(s).set({ retryAt: retryAt.toISOString() }).where(eq(s.id, id)).run()
        return
      }
      await postgresDb(tx).update(p).set({ retryAt }).where(eq(p.id, id))
    },
    async countDead(tx) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select({ n: sql<number>`count(*)` })
          .from(s)
          .where(isNotNull(s.deadAt))
          .get()
        return Number(row?.n ?? 0)
      }
      const [row] = await postgresDb(tx)
        .select({ n: sql<string>`count(*)` })
        .from(p)
        .where(isNotNull(p.deadAt))
      return Number(row?.n ?? 0)
    },
    listDead(tx, limit) {
      return select(tx, { sqlite: [isNotNull(s.deadAt)], postgres: [isNotNull(p.deadAt)] }, limit)
    },
    async countRetrying(tx) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select({ n: sql<number>`count(*)` })
          .from(s)
          .where(and(isNull(s.deliveredAt), isNull(s.deadAt), gt(s.attempts, 0)))
          .get()
        return Number(row?.n ?? 0)
      }
      const [row] = await postgresDb(tx)
        .select({ n: sql<string>`count(*)` })
        .from(p)
        .where(and(isNull(p.deliveredAt), isNull(p.deadAt), gt(p.attempts, 0)))
      return Number(row?.n ?? 0)
    },
    async deleteDeliveredBefore(tx, at) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .delete(s)
          .where(and(isNotNull(s.deliveredAt), lt(s.deliveredAt, at.toISOString())))
          .run()
        return result.changes
      }
      const result = await postgresDb(tx)
        .delete(p)
        .where(and(isNotNull(p.deliveredAt), lt(p.deliveredAt, at)))
      return result.rowCount ?? 0
    },
    async listAll(tx) {
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx).select(sqliteLogged).from(s).orderBy(asc(s.seq)).all().map(rowToLogged)
      }
      const rows = await postgresDb(tx).select(postgresLogged).from(p).orderBy(asc(p.seq))
      return rows.map(rowToLogged)
    },
    queryByCorrelation(tx, correlationId, filter) {
      return select(
        tx,
        {
          sqlite: [eq(s.correlationId, correlationId), ...sqliteWhere(filter)],
          postgres: [eq(p.correlationId, correlationId), ...postgresWhere(filter)],
        },
        filter.limit,
      )
    },
    listAfter(tx, seq, filter) {
      return select(
        tx,
        {
          sqlite: [gt(s.seq, seq), ...sqliteWhere(filter)],
          postgres: [gt(p.seq, seq), ...postgresWhere(filter)],
        },
        filter.limit,
      )
    },
    async maxSeq(tx) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select({ max: sql<number | null>`max(${s.seq})` })
          .from(s)
          .get()
        return Number(row?.max ?? 0)
      }
      const [row] = await postgresDb(tx)
        .select({ max: sql<string | null>`max(${p.seq})` })
        .from(p)
      return Number(row?.max ?? 0)
    },
    // Only the columns a LoggedEvent maps: a boot rebuild runs this on a store not yet migrated past 0007.
    async listForCatchUp(tx, since, page = {}) {
      const afterSeq = page.afterSeq ?? 0
      const limit = page.limit ?? CATCH_UP_LIMIT
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx)
          .select(sqliteLogged)
          .from(s)
          .where(
            and(
              isNull(s.deadAt),
              or(isNull(s.deliveredAt), gte(s.deliveredAt, since.toISOString())),
              gt(s.seq, afterSeq),
            ),
          )
          .orderBy(asc(s.seq))
          .limit(limit)
          .all()
          .map(rowToLogged)
      }
      const rows = await postgresDb(tx)
        .select(postgresLogged)
        .from(p)
        .where(
          and(
            isNull(p.deadAt),
            or(isNull(p.deliveredAt), gte(p.deliveredAt, since)),
            gt(p.seq, afterSeq),
          ),
        )
        .orderBy(asc(p.seq))
        .limit(limit)
      return rows.map(rowToLogged)
    },
    listDeliveredBefore(tx, at, limit) {
      return select(
        tx,
        {
          sqlite: [isNull(s.deadAt), isNotNull(s.deliveredAt), lt(s.deliveredAt, at.toISOString())],
          postgres: [isNull(p.deadAt), isNotNull(p.deliveredAt), lt(p.deliveredAt, at)],
        },
        limit,
      )
    },
    async deleteSeqs(tx, seqs) {
      let deleted = 0
      for (let i = 0; i < seqs.length; i += DELETE_CHUNK) {
        const chunk = seqs.slice(i, i + DELETE_CHUNK)
        if (tx.kind === 'sqlite') {
          deleted += sqliteDb(tx)
            .delete(s)
            .where(and(inArray(s.seq, chunk), isNotNull(s.deliveredAt), isNull(s.deadAt)))
            .run().changes
        } else {
          const result = await postgresDb(tx)
            .delete(p)
            .where(and(inArray(p.seq, chunk), isNotNull(p.deliveredAt), isNull(p.deadAt)))
          deleted += result.rowCount ?? 0
        }
      }
      return deleted
    },
    async listBySubjects(tx, subjects, page) {
      if (subjects.length === 0) return []
      const afterSeq = page.afterSeq ?? 0
      return select(
        tx,
        {
          sqlite: [
            or(...subjects.map((x) => and(eq(s.subjectType, x.type), eq(s.subjectId, x.id))))!,
            gt(s.seq, afterSeq),
            ...(page.until === undefined ? [] : [lte(s.createdAt, page.until.toISOString())]),
          ],
          postgres: [
            or(...subjects.map((x) => and(eq(p.subjectType, x.type), eq(p.subjectId, x.id))))!,
            gt(p.seq, afterSeq),
            ...(page.until === undefined ? [] : [lte(p.createdAt, page.until)]),
          ],
        },
        page.limit,
      )
    },
  }
}
