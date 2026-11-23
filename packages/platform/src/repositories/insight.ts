import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm'
import type { InsightFacts, InsightSeverity, InsightStatus } from '@nymbalhq/types'
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
import { fromTimestamp, parseJson } from './json.js'

/** One `insights` row. */
export interface InsightRecord {
  id: string
  job: string
  subject: string
  runDay: string
  dataDay: string
  status: InsightStatus
  severity: InsightSeverity
  summary: string
  facts: InsightFacts
  createdAt: string
  dismissedAt: string | null
  /** The model's text; null unless its status is `written`. */
  guidance: string | null
  /** Null until a night's guidance pass claims the insight. */
  guidanceStatus: GuidanceStatus | null
}

export type GuidanceStatus = 'pending' | 'written' | 'withheld' | 'failed'

export type InsightInsert = Omit<
  InsightRecord,
  'createdAt' | 'dismissedAt' | 'guidance' | 'guidanceStatus'
> & {
  createdAt: Date
  dismissedAt: Date | null
}

export type NightShiftRunStatus = 'running' | 'done' | 'failed'

export interface NightShiftRunFinish {
  status: Exclude<NightShiftRunStatus, 'running'>
  at: Date
  insights: number
  error: string | null
}

/** A run that failed, or is still `running` from before `staleBefore`. */
export interface ProblemRun {
  job: string
  runDay: string
  status: NightShiftRunStatus
}

export interface InsightQuery {
  runDay?: string
  job?: string
  status?: InsightStatus
}

export interface InsightRepository extends StoreRepository {
  /** Claims the job for the night; false when a run of it already holds the claim. */
  claimRun(tx: Tx, job: string, runDay: string, at: Date): Promise<boolean>
  finishRun(tx: Tx, job: string, runDay: string, finish: NightShiftRunFinish): Promise<void>
  /** False when an insight already holds the (job, subject, run day) key: that row stands. */
  insert(tx: Tx, row: InsightInsert): Promise<boolean>
  /** Whether the subject has an open insight of any day, or one dismissed at or after `dismissedSince`. */
  suppressed(tx: ReadTx, job: string, subject: string, dismissedSince: Date): Promise<boolean>
  findById(tx: ReadTx, id: string): Promise<InsightRecord | null>
  /** Dismisses an open insight at `at`; false when there is no such row or it is already dismissed. */
  dismiss(tx: Tx, id: string, at: Date): Promise<boolean>
  /** Oldest run day first, then subject. */
  list(tx: ReadTx, q: InsightQuery): Promise<InsightRecord[]>
  problemRuns(tx: ReadTx, days: string[], staleBefore: Date): Promise<ProblemRun[]>
  /** The open insights of `runDay` of one of `jobs` that no guidance pass has claimed. */
  unguided(tx: ReadTx, runDay: string, jobs: readonly string[]): Promise<InsightRecord[]>
  /** How many insights of `runDay` a guidance pass has claimed. */
  guidedCount(tx: ReadTx, runDay: string): Promise<number>
  /** Marks the insight `pending`; false when a pass already claimed it. */
  claimGuidance(tx: Tx, id: string): Promise<boolean>
  /** Settles a `pending` insight; `guidance` is stored only when written. */
  settleGuidance(
    tx: Tx,
    id: string,
    status: Exclude<GuidanceStatus, 'pending'>,
    guidance: string | null,
  ): Promise<void>
}

type InsightTable = typeof sqliteSchema.insights | typeof postgresSchema.insights
type RunTable = typeof sqliteSchema.nightShiftRuns | typeof postgresSchema.nightShiftRuns

function toRecord(kind: 'sqlite' | 'postgres', row: Record<string, unknown>): InsightRecord {
  return {
    id: String(row['id']),
    job: String(row['job']),
    subject: String(row['subject']),
    runDay: String(row['runDay']),
    dataDay: String(row['dataDay']),
    status: row['status'] as InsightStatus,
    severity: row['severity'] as InsightSeverity,
    summary: String(row['summary']),
    facts: parseJson<InsightFacts>(kind, row['facts'], {}),
    createdAt: fromTimestamp(row['createdAt']),
    dismissedAt: row['dismissedAt'] == null ? null : fromTimestamp(row['dismissedAt']),
    guidance: row['guidance'] == null ? null : String(row['guidance']),
    guidanceStatus: (row['guidanceStatus'] ?? null) as GuidanceStatus | null,
  }
}

function unguidedWhere(t: InsightTable, runDay: string, jobs: readonly string[]): SQL | undefined {
  return and(
    eq(t.runDay, runDay),
    eq(t.status, 'open'),
    inArray(t.job, [...jobs]),
    isNull(t.guidanceStatus),
  )
}

function listWhere(t: InsightTable, q: InsightQuery): SQL | undefined {
  return and(
    q.runDay === undefined ? undefined : eq(t.runDay, q.runDay),
    q.job === undefined ? undefined : eq(t.job, q.job),
    q.status === undefined ? undefined : eq(t.status, q.status),
  )
}

function suppressedWhere(
  t: InsightTable,
  job: string,
  subject: string,
  dismissedSince: string | Date,
): SQL | undefined {
  return and(
    eq(t.job, job),
    eq(t.subject, subject),
    or(eq(t.status, 'open'), and(eq(t.status, 'dismissed'), gte(t.dismissedAt, dismissedSince))),
  )
}

function problemWhere(t: RunTable, days: string[], staleBefore: string | Date): SQL | undefined {
  return and(
    inArray(t.runDay, days),
    or(eq(t.status, 'failed'), and(eq(t.status, 'running'), lt(t.startedAt, staleBefore))),
  )
}

export function createInsightRepository(store: CommandStore): InsightRepository {
  const si = sqliteSchema.insights
  const pi = postgresSchema.insights
  const sr = sqliteSchema.nightShiftRuns
  const pr = postgresSchema.nightShiftRuns
  return {
    store,
    async claimRun(tx, job, runDay, at) {
      const values = { job, runDay, status: 'running', insights: 0 }
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .insert(sr)
          .values({ ...values, startedAt: at.toISOString() })
          .onConflictDoNothing()
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx)
        .insert(pr)
        .values({ ...values, startedAt: at })
        .onConflictDoNothing()
      return (result.rowCount ?? 0) > 0
    },
    async finishRun(tx, job, runDay, finish) {
      const set = { status: finish.status, insights: finish.insights, error: finish.error }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(sr)
          .set({ ...set, finishedAt: finish.at.toISOString() })
          .where(and(eq(sr.job, job), eq(sr.runDay, runDay)))
          .run()
        return
      }
      await postgresDb(tx)
        .update(pr)
        .set({ ...set, finishedAt: finish.at })
        .where(and(eq(pr.job, job), eq(pr.runDay, runDay)))
    },
    async insert(tx, row) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .insert(si)
          .values({
            ...row,
            facts: JSON.stringify(row.facts),
            createdAt: row.createdAt.toISOString(),
            dismissedAt: row.dismissedAt === null ? null : row.dismissedAt.toISOString(),
          })
          .onConflictDoNothing()
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx).insert(pi).values(row).onConflictDoNothing()
      return (result.rowCount ?? 0) > 0
    },
    async suppressed(tx, job, subject, dismissedSince) {
      const found =
        tx.kind === 'sqlite'
          ? sqliteDb(tx)
              .select({ id: si.id })
              .from(si)
              .where(suppressedWhere(si, job, subject, dismissedSince.toISOString()))
              .limit(1)
              .all()
          : await postgresDb(tx)
              .select({ id: pi.id })
              .from(pi)
              .where(suppressedWhere(pi, job, subject, dismissedSince))
              .limit(1)
      return found.length > 0
    },
    async findById(tx, id) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx).select().from(si).where(eq(si.id, id)).get()
        return row === undefined ? null : toRecord('sqlite', row)
      }
      const [row] = await postgresDb(tx).select().from(pi).where(eq(pi.id, id)).limit(1)
      return row === undefined ? null : toRecord('postgres', row)
    },
    async dismiss(tx, id, at) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .update(si)
          .set({ status: 'dismissed', dismissedAt: at.toISOString() })
          .where(and(eq(si.id, id), eq(si.status, 'open')))
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx)
        .update(pi)
        .set({ status: 'dismissed', dismissedAt: at })
        .where(and(eq(pi.id, id), eq(pi.status, 'open')))
      return (result.rowCount ?? 0) > 0
    },
    async list(tx, q) {
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx)
          .select()
          .from(si)
          .where(listWhere(si, q))
          .orderBy(asc(si.runDay), asc(si.subject))
          .all()
          .map((row) => toRecord('sqlite', row))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(pi)
        .where(listWhere(pi, q))
        .orderBy(asc(pi.runDay), asc(pi.subject))
      return rows.map((row) => toRecord('postgres', row))
    },
    async problemRuns(tx, days, staleBefore) {
      if (days.length === 0) return []
      const rows =
        tx.kind === 'sqlite'
          ? sqliteDb(tx)
              .select({ job: sr.job, runDay: sr.runDay, status: sr.status })
              .from(sr)
              .where(problemWhere(sr, days, staleBefore.toISOString()))
              .orderBy(asc(sr.runDay), asc(sr.job))
              .all()
          : await postgresDb(tx)
              .select({ job: pr.job, runDay: pr.runDay, status: pr.status })
              .from(pr)
              .where(problemWhere(pr, days, staleBefore))
              .orderBy(asc(pr.runDay), asc(pr.job))
      return rows.map((r) => ({ ...r, status: r.status as NightShiftRunStatus }))
    },
    async unguided(tx, runDay, jobs) {
      if (jobs.length === 0) return []
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx)
          .select()
          .from(si)
          .where(unguidedWhere(si, runDay, jobs))
          .orderBy(asc(si.createdAt), asc(si.id))
          .all()
          .map((row) => toRecord('sqlite', row))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(pi)
        .where(unguidedWhere(pi, runDay, jobs))
        .orderBy(asc(pi.createdAt), asc(pi.id))
      return rows.map((row) => toRecord('postgres', row))
    },
    async guidedCount(tx, runDay) {
      const [row] =
        tx.kind === 'sqlite'
          ? sqliteDb(tx)
              .select({ n: count() })
              .from(si)
              .where(and(eq(si.runDay, runDay), isNotNull(si.guidanceStatus)))
              .all()
          : await postgresDb(tx)
              .select({ n: count() })
              .from(pi)
              .where(and(eq(pi.runDay, runDay), isNotNull(pi.guidanceStatus)))
      return Number(row?.n ?? 0)
    },
    async claimGuidance(tx, id) {
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .update(si)
          .set({ guidanceStatus: 'pending' })
          .where(and(eq(si.id, id), isNull(si.guidanceStatus)))
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx)
        .update(pi)
        .set({ guidanceStatus: 'pending' })
        .where(and(eq(pi.id, id), isNull(pi.guidanceStatus)))
      return (result.rowCount ?? 0) > 0
    },
    async settleGuidance(tx, id, status, guidance) {
      const set = { guidanceStatus: status, guidance: status === 'written' ? guidance : null }
      if (tx.kind === 'sqlite') {
        sqliteDb(tx)
          .update(si)
          .set(set)
          .where(and(eq(si.id, id), eq(si.guidanceStatus, 'pending')))
          .run()
        return
      }
      await postgresDb(tx)
        .update(pi)
        .set(set)
        .where(and(eq(pi.id, id), eq(pi.guidanceStatus, 'pending')))
    },
  }
}
