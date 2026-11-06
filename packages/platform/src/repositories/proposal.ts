import { and, desc, eq, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import type { ProposalDecider, ProposalStatus, ProposalView } from '@nymbalhq/types'
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

/** One `proposals` row. */
export interface ProposalRecord {
  id: string
  tool: string
  command: string
  args: Record<string, unknown>
  /** Argument name to value: the credentials (a cart id) the call carried as handles. */
  handles: Record<string, string> | null
  idempotencyKey: string | null
  proposerId: string | null
  agentName: string
  agentVersion: string | null
  correlationId: string
  status: ProposalStatus
  decidedByKind: 'admin' | 'policy' | null
  decidedBy: string | null
  decidedAt: string | null
  reason: string | null
  outcomeStatus: number | null
  outcomeCode: string | null
  outcomeMessage: string | null
  createdAt: string
  settledAt: string | null
}

export type ProposalInsert = Pick<
  ProposalRecord,
  | 'id'
  | 'tool'
  | 'command'
  | 'args'
  | 'handles'
  | 'idempotencyKey'
  | 'proposerId'
  | 'agentName'
  | 'agentVersion'
  | 'correlationId'
> & { createdAt: Date }

export interface ProposalDecision {
  status: 'approved' | 'rejected'
  by: ProposalDecider
  at: Date
  reason?: string | undefined
}

export interface ProposalSettlement {
  status: 'applied' | 'failed'
  outcome: { status: number; code?: string; message?: string }
  at: Date
}

/** A position in the (created_at, id) order proposals are listed in, newest first. */
export interface ProposalCursor {
  at: string
  id: string
}

export interface ProposalQuery {
  status: 'pending' | 'decided' | 'all'
  cursor?: ProposalCursor
  limit: number
}

export interface ProposalRepository extends StoreRepository {
  /** False when the proposer already has a row for the tool under the key: that row stands. */
  insert(tx: Tx, row: ProposalInsert): Promise<boolean>
  findById(tx: ReadTx, id: string): Promise<ProposalRecord | null>
  findByKey(
    tx: ReadTx,
    proposerId: string,
    tool: string,
    key: string,
  ): Promise<ProposalRecord | null>
  /** Decides a pending row; false when it was not pending (or does not exist). */
  decide(tx: Tx, id: string, decision: ProposalDecision): Promise<boolean>
  /** Settles an approved row with what its command answered; false when it was not approved. */
  settle(tx: Tx, id: string, settlement: ProposalSettlement): Promise<boolean>
  /** Newest first, the rows before `cursor`, at most `limit`. */
  list(tx: ReadTx, q: ProposalQuery): Promise<ProposalRecord[]>
  countPending(tx: ReadTx): Promise<number>
}

type Table = typeof sqliteSchema.proposals | typeof postgresSchema.proposals

function toRecord(kind: 'sqlite' | 'postgres', row: Record<string, unknown>): ProposalRecord {
  const time = (value: unknown) => (value === null ? null : fromTimestamp(value))
  return {
    id: String(row['id']),
    tool: String(row['tool']),
    command: String(row['command']),
    args: parseJson<Record<string, unknown>>(kind, row['args'], {}),
    handles: parseJson<Record<string, string> | null>(kind, row['handles'], null),
    idempotencyKey: (row['idempotencyKey'] as string | null) ?? null,
    proposerId: (row['proposerId'] as string | null) ?? null,
    agentName: String(row['agentName']),
    agentVersion: (row['agentVersion'] as string | null) ?? null,
    correlationId: String(row['correlationId']),
    status: row['status'] as ProposalStatus,
    decidedByKind: (row['decidedByKind'] as 'admin' | 'policy' | null) ?? null,
    decidedBy: (row['decidedBy'] as string | null) ?? null,
    decidedAt: time(row['decidedAt'] ?? null),
    reason: (row['reason'] as string | null) ?? null,
    outcomeStatus: row['outcomeStatus'] === null ? null : Number(row['outcomeStatus']),
    outcomeCode: (row['outcomeCode'] as string | null) ?? null,
    outcomeMessage: (row['outcomeMessage'] as string | null) ?? null,
    createdAt: fromTimestamp(row['createdAt']),
    settledAt: time(row['settledAt'] ?? null),
  }
}

export function encodeProposalCursor(row: Pick<ProposalRecord, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.createdAt, row.id])).toString('base64url')
}

/** A cursor `encodeProposalCursor` made, or undefined for anything else. */
export function decodeProposalCursor(value: string): ProposalCursor | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === 'string' &&
      typeof decoded[1] === 'string' &&
      !Number.isNaN(Date.parse(decoded[0]))
    ) {
      return { at: decoded[0], id: decoded[1] }
    }
  } catch {
    // Not base64url JSON: no cursor of ours.
  }
  return undefined
}

/** The row as the admin reads it: a handle by its argument's name only. */
export function proposalView(row: ProposalRecord): ProposalView {
  const decider: ProposalDecider | undefined =
    row.decidedByKind === 'admin'
      ? { kind: 'admin', id: row.decidedBy ?? '' }
      : row.decidedByKind === 'policy'
        ? { kind: 'policy', rule: row.decidedBy as 'agents.mcp.writes' | 'agents.autoApprove' }
        : undefined
  return {
    id: row.id,
    tool: row.tool,
    title: row.tool.split('_').join('.'),
    command: row.command,
    args: row.args,
    handles: Object.keys(row.handles ?? {}),
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    proposer: {
      userId: row.proposerId,
      agent: {
        name: row.agentName,
        ...(row.agentVersion !== null && { version: row.agentVersion }),
      },
    },
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    ...(decider !== undefined && {
      decision: {
        by: decider,
        at: row.decidedAt ?? row.createdAt,
        ...(row.reason !== null && { reason: row.reason }),
      },
    }),
    ...(row.outcomeStatus !== null && {
      outcome: {
        status: row.outcomeStatus,
        ...(row.outcomeCode !== null && { code: row.outcomeCode }),
        ...(row.outcomeMessage !== null && { message: row.outcomeMessage }),
      },
    }),
  }
}

function deciderColumns(by: ProposalDecider) {
  return by.kind === 'admin'
    ? { decidedByKind: 'admin', decidedBy: by.id }
    : { decidedByKind: 'policy', decidedBy: by.rule }
}

function listWhere(
  t: Table,
  q: ProposalQuery,
  at: (iso: string) => string | Date,
): SQL | undefined {
  const cursor = q.cursor
  return and(
    q.status === 'pending' ? eq(t.status, 'pending') : undefined,
    q.status === 'decided' ? ne(t.status, 'pending') : undefined,
    cursor === undefined
      ? undefined
      : or(
          lt(t.createdAt, at(cursor.at)),
          and(eq(t.createdAt, at(cursor.at)), lt(t.id, cursor.id)),
        ),
  )
}

export function createProposalRepository(store: CommandStore): ProposalRepository {
  const s = sqliteSchema.proposals
  const p = postgresSchema.proposals
  return {
    store,
    async insert(tx, row) {
      const values = {
        id: row.id,
        tool: row.tool,
        command: row.command,
        idempotencyKey: row.idempotencyKey,
        proposerId: row.proposerId,
        agentName: row.agentName,
        agentVersion: row.agentVersion,
        correlationId: row.correlationId,
        status: 'pending',
      }
      // A second insert under the proposer's key is no error: the partial unique index keeps the first.
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .insert(s)
          .values({
            ...values,
            args: JSON.stringify(row.args),
            handles: row.handles === null ? null : JSON.stringify(row.handles),
            createdAt: row.createdAt.toISOString(),
          })
          .onConflictDoNothing()
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx)
        .insert(p)
        .values({ ...values, args: row.args, handles: row.handles, createdAt: row.createdAt })
        .onConflictDoNothing()
      return (result.rowCount ?? 0) > 0
    },
    async findById(tx, id) {
      const row: Record<string, unknown> | undefined =
        tx.kind === 'sqlite'
          ? sqliteDb(tx).select().from(s).where(eq(s.id, id)).get()
          : (await postgresDb(tx).select().from(p).where(eq(p.id, id)).limit(1))[0]
      return row === undefined ? null : toRecord(tx.kind, row)
    },
    async findByKey(tx, proposerId, tool, key) {
      const match = (t: Table) =>
        and(eq(t.proposerId, proposerId), eq(t.tool, tool), eq(t.idempotencyKey, key))
      const row: Record<string, unknown> | undefined =
        tx.kind === 'sqlite'
          ? sqliteDb(tx).select().from(s).where(match(s)).get()
          : (await postgresDb(tx).select().from(p).where(match(p)).limit(1))[0]
      return row === undefined ? null : toRecord(tx.kind, row)
    },
    async decide(tx, id, decision) {
      const set = {
        status: decision.status,
        ...deciderColumns(decision.by),
        reason: decision.reason ?? null,
      }
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .update(s)
          .set({ ...set, decidedAt: decision.at.toISOString() })
          .where(and(eq(s.id, id), eq(s.status, 'pending')))
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx)
        .update(p)
        .set({ ...set, decidedAt: decision.at })
        .where(and(eq(p.id, id), eq(p.status, 'pending')))
      return (result.rowCount ?? 0) > 0
    },
    async settle(tx, id, settlement) {
      const set = {
        status: settlement.status,
        outcomeStatus: settlement.outcome.status,
        outcomeCode: settlement.outcome.code ?? null,
        outcomeMessage: settlement.outcome.message ?? null,
      }
      if (tx.kind === 'sqlite') {
        const result = sqliteDb(tx)
          .update(s)
          .set({ ...set, settledAt: settlement.at.toISOString() })
          .where(and(eq(s.id, id), eq(s.status, 'approved')))
          .run()
        return result.changes > 0
      }
      const result = await postgresDb(tx)
        .update(p)
        .set({ ...set, settledAt: settlement.at })
        .where(and(eq(p.id, id), eq(p.status, 'approved')))
      return (result.rowCount ?? 0) > 0
    },
    async list(tx, q) {
      if (tx.kind === 'sqlite') {
        return sqliteDb(tx)
          .select()
          .from(s)
          .where(listWhere(s, q, (iso) => iso))
          .orderBy(desc(s.createdAt), desc(s.id))
          .limit(q.limit)
          .all()
          .map((row) => toRecord('sqlite', row))
      }
      const rows = await postgresDb(tx)
        .select()
        .from(p)
        .where(listWhere(p, q, (iso) => new Date(iso)))
        .orderBy(desc(p.createdAt), desc(p.id))
        .limit(q.limit)
      return rows.map((row) => toRecord('postgres', row))
    },
    async countPending(tx) {
      const n = sql<number | string>`count(*)`
      const [row] =
        tx.kind === 'sqlite'
          ? sqliteDb(tx).select({ n }).from(s).where(eq(s.status, 'pending')).all()
          : await postgresDb(tx).select({ n }).from(p).where(eq(p.status, 'pending'))
      return Number(row?.n ?? 0)
    },
  }
}
