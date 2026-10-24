import { and, asc, desc, eq, gt, gte, lt, or, sql, type SQL } from 'drizzle-orm'
import type { AuditActor, AuditEntry, AuditOutcome, AuditSubject } from '@nymbalhq/types'
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

export interface AuditEntryInsert {
  id: string
  at: Date
  actor: AuditActor
  command: string
  subjects: AuditSubject[]
  correlationId: string | null
  idempotencyKey: string | null
  requestHash: string | null
  outcome: AuditOutcome
  responseStatus: number | null
  /** Kept only on a keyed `applied` row, to answer its replays. */
  responseBody: unknown
}

/** A keyed `applied` row: what its replays answer. */
export interface AppliedEntry {
  requestHash: string | null
  subjects: AuditSubject[]
  responseStatus: number
  responseBody: unknown
}

/** A position in the (at, id) order the entries are listed in. */
export interface AuditCursor {
  at: string
  id: string
}

export interface AuditQuery {
  /** `kind:id`, a kind alone, or an actor id. */
  actor?: string
  command?: string
  /** A subject's id. */
  subject?: string
  correlation?: string
  outcome?: AuditOutcome
  /** From `since` inclusive to `until` exclusive. */
  since?: Date
  until?: Date
  /** `desc`: newest first, the entries before `cursor`; `asc`: oldest first, the entries after it. */
  order: 'asc' | 'desc'
  cursor?: AuditCursor
  limit: number
}

const ACTOR_KINDS = new Set<string>(['admin', 'customer', 'guest', 'system', 'import'])

type Table = typeof sqliteSchema.auditEntries | typeof postgresSchema.auditEntries

function actorFilter(t: Table, actor: string): SQL | undefined {
  const colon = actor.indexOf(':')
  if (colon > 0) {
    return and(eq(t.actorKind, actor.slice(0, colon)), eq(t.actorId, actor.slice(colon + 1)))
  }
  return ACTOR_KINDS.has(actor) ? eq(t.actorKind, actor) : eq(t.actorId, actor)
}

function where(
  t: Table,
  q: AuditQuery,
  at: (d: Date | string) => string | Date,
  subjectHas: (id: string) => SQL,
): SQL | undefined {
  const cursor = q.cursor
  const beyond =
    cursor === undefined
      ? undefined
      : q.order === 'desc'
        ? or(lt(t.at, at(cursor.at)), and(eq(t.at, at(cursor.at)), lt(t.id, cursor.id)))
        : or(gt(t.at, at(cursor.at)), and(eq(t.at, at(cursor.at)), gt(t.id, cursor.id)))
  return and(
    q.actor === undefined ? undefined : actorFilter(t, q.actor),
    q.command === undefined ? undefined : eq(t.command, q.command),
    q.subject === undefined ? undefined : subjectHas(q.subject),
    q.correlation === undefined ? undefined : eq(t.correlationId, q.correlation),
    q.outcome === undefined ? undefined : eq(t.outcome, q.outcome),
    q.since === undefined ? undefined : gte(t.at, at(q.since)),
    q.until === undefined ? undefined : lt(t.at, at(q.until)),
    beyond,
  )
}

function parsed<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

function toEntry(row: Record<string, unknown>): AuditEntry {
  const at = row.at instanceof Date ? row.at.toISOString() : String(row.at)
  return {
    id: String(row.id),
    at,
    actor: { kind: row.actorKind as AuditActor['kind'], id: String(row.actorId) },
    command: String(row.command),
    subjects: parsed<AuditSubject[]>(row.subjects),
    correlationId: (row.correlationId as string | null) ?? null,
    idempotencyKey: (row.idempotencyKey as string | null) ?? null,
    outcome: row.outcome as AuditOutcome,
    responseStatus: row.responseStatus === null ? null : Number(row.responseStatus),
  }
}

const listed = {
  id: true,
  at: true,
  actorKind: true,
  actorId: true,
  command: true,
  subjects: true,
  correlationId: true,
  idempotencyKey: true,
  outcome: true,
  responseStatus: true,
} as const

/** Appends one entry in `tx`. Entries are never updated or deleted (the tables' triggers refuse it). */
export async function appendAuditEntry(tx: Tx, e: AuditEntryInsert): Promise<void> {
  const common = {
    id: e.id,
    actorKind: e.actor.kind,
    actorId: e.actor.id,
    command: e.command,
    correlationId: e.correlationId,
    idempotencyKey: e.idempotencyKey,
    requestHash: e.requestHash,
    outcome: e.outcome,
    responseStatus: e.responseStatus,
  }
  const body = e.responseBody === undefined ? null : e.responseBody
  if (tx.kind === 'sqlite') {
    sqliteDb(tx)
      .insert(sqliteSchema.auditEntries)
      .values({
        ...common,
        at: e.at.toISOString(),
        subjects: JSON.stringify(e.subjects),
        responseBody: body === null ? null : JSON.stringify(body),
      })
      .run()
    return
  }
  await postgresDb(tx)
    .insert(postgresSchema.auditEntries)
    .values({ ...common, at: e.at, subjects: e.subjects, responseBody: body })
}

/** The `applied` entry `actorId` made of `command` under `key`, if any. */
export async function findAppliedByKey(
  tx: ReadTx,
  actorId: string,
  command: string,
  key: string,
): Promise<AppliedEntry | null> {
  const match = (t: Table) =>
    and(
      eq(t.actorId, actorId),
      eq(t.command, command),
      eq(t.idempotencyKey, key),
      eq(t.outcome, 'applied'),
    )
  const s = sqliteSchema.auditEntries
  const p = postgresSchema.auditEntries
  const row: Record<string, unknown> | undefined =
    tx.kind === 'sqlite'
      ? sqliteDb(tx).select().from(s).where(match(s)).limit(1).get()
      : (await postgresDb(tx).select().from(p).where(match(p)).limit(1))[0]
  if (row === undefined) return null
  return {
    requestHash: (row.requestHash as string | null) ?? null,
    subjects: parsed<AuditSubject[]>(row.subjects),
    responseStatus: Number(row.responseStatus),
    responseBody: row.responseBody === null ? null : parsed<unknown>(row.responseBody),
  }
}

/** Entries matching `q`, in its order, at most `q.limit`; never a stored response body. */
export async function listAuditEntries(tx: ReadTx, q: AuditQuery): Promise<AuditEntry[]> {
  const direction = q.order === 'desc' ? desc : asc
  if (tx.kind === 'sqlite') {
    const t = sqliteSchema.auditEntries
    const rows = sqliteDb(tx)
      .select(pick(t))
      .from(t)
      .where(
        where(
          t,
          q,
          (d) => (d instanceof Date ? d.toISOString() : d),
          (id) =>
            sql`EXISTS (SELECT 1 FROM json_each(${t.subjects}) WHERE json_extract(json_each.value, '$.id') = ${id})`,
        ),
      )
      .orderBy(direction(t.at), direction(t.id))
      .limit(q.limit)
      .all()
    return rows.map((r) => toEntry(r as Record<string, unknown>))
  }
  const t = postgresSchema.auditEntries
  const rows = await postgresDb(tx)
    .select(pick(t))
    .from(t)
    .where(
      where(
        t,
        q,
        (d) => (d instanceof Date ? d : new Date(d)),
        (id) => sql`${t.subjects} @> jsonb_build_array(jsonb_build_object('id', ${id}::text))`,
      ),
    )
    .orderBy(direction(t.at), direction(t.id))
    .limit(q.limit)
  return rows.map((r) => toEntry(r as Record<string, unknown>))
}

function pick<T extends Table>(t: T) {
  return Object.fromEntries(Object.keys(listed).map((k) => [k, t[k as keyof typeof listed]])) as {
    [K in keyof typeof listed]: T[K]
  }
}

export type AuditFilter = Omit<AuditQuery, 'order' | 'cursor' | 'limit'>

/** Every entry matching `filter`, oldest first, one read per page: what both exports print, a line each. */
export async function* auditEntriesInOrder(
  store: CommandStore,
  filter: AuditFilter,
  pageSize = 500,
): AsyncGenerator<AuditEntry> {
  let cursor: AuditCursor | undefined
  for (;;) {
    const after = cursor
    const page = await store.read((tx) =>
      listAuditEntries(tx, {
        ...filter,
        order: 'asc',
        limit: pageSize,
        ...(after !== undefined && { cursor: after }),
      }),
    )
    yield* page
    if (page.length < pageSize) return
    const last = page[page.length - 1]!
    cursor = { at: last.at, id: last.id }
  }
}

export interface AuditEntryRepository extends StoreRepository {
  append(tx: Tx, entry: AuditEntryInsert): Promise<void>
  findAppliedByKey(
    tx: ReadTx,
    actorId: string,
    command: string,
    key: string,
  ): Promise<AppliedEntry | null>
  list(tx: ReadTx, query: AuditQuery): Promise<AuditEntry[]>
}

export function createAuditEntryRepository(store: CommandStore): AuditEntryRepository {
  return {
    store,
    append: appendAuditEntry,
    findAppliedByKey,
    list: listAuditEntries,
  }
}
