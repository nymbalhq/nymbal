import type { RawReader } from './raw.js'

// The `audit_entries` table as a second connection reads it, and the HTTP half (audit-http.ts) re-exported. Nothing
// here knows how the audit scope, the idempotency wrapper or the repository are implemented.

export * from './audit-http.js'

export type Outcome = 'applied' | 'refused' | 'replayed'

export interface AuditRow {
  id: string
  at: string
  actorKind: string
  actorId: string
  command: string
  subjects: Array<{ type: string; id: string }>
  correlationId: string | null
  idempotencyKey: string | null
  requestHash: string | null
  outcome: Outcome
  responseStatus: number | null
  responseBody: unknown
}

interface RawAuditRow {
  id: string
  at: string | Date
  actor_kind: string
  actor_id: string
  command: string
  subjects: string | Array<{ type: string; id: string }>
  correlation_id: string | null
  idempotency_key: string | null
  request_hash: string | null
  outcome: Outcome
  response_status: number | string | null
  response_body: unknown
}

function parsed<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

/** `audit_entries` rows as committed, oldest first (`at`, then `id`). SQLite keeps JSON as text, Postgres as jsonb. */
export async function auditRows(
  raw: RawReader,
  where?: string,
  params: unknown[] = [],
): Promise<AuditRow[]> {
  const rows = await raw.rows<RawAuditRow>(
    `SELECT id, at, actor_kind, actor_id, command, subjects, correlation_id, idempotency_key, request_hash, outcome,
            response_status, response_body
       FROM audit_entries${where ? ` WHERE ${where}` : ''} ORDER BY at, id`,
    params,
  )
  return rows.map((r) => ({
    id: r.id,
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    command: r.command,
    subjects: parsed<Array<{ type: string; id: string }>>(r.subjects),
    correlationId: r.correlation_id,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    outcome: r.outcome,
    responseStatus: r.response_status === null ? null : Number(r.response_status),
    responseBody: r.response_body === null ? null : parsed<unknown>(r.response_body),
  }))
}

/** The rows one request left: those carrying its response's correlation id. */
export function rowsOf(raw: RawReader, correlationId: string | null): Promise<AuditRow[]> {
  if (correlationId === null) throw new Error('the response carried no x-correlation-id')
  return auditRows(raw, 'correlation_id = ?', [correlationId])
}

export function subjectIds(rows: AuditRow[]): string[] {
  return rows.flatMap((r) => r.subjects.map((s) => s.id))
}

export function outcomesOf(rows: AuditRow[]): Outcome[] {
  return rows.map((r) => r.outcome).sort()
}
