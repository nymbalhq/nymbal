import { and, asc, eq, gte, inArray, lt, or, type SQL } from 'drizzle-orm'
import type { InsightFacts, InsightSeverity } from '@nymbalhq/types'
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

export type InsightStatus = 'open' | 'dismissed'

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
}

export type InsightInsert = Omit<InsightRecord, 'createdAt' | 'dismissedAt'> & {
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
  /** Oldest run day first, then subject. */
  list(tx: ReadTx, q: InsightQuery): Promise<InsightRecord[]>
  problemRuns(tx: ReadTx, days: string[], staleBefore: Date): Promise<ProblemRun[]>
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
  }
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
  }
}
