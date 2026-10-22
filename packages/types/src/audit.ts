/** Who a command ran for. A guest is `guest:anonymous`: a cart's token is a bearer credential and is never an id. */
export interface AuditActor {
  kind: 'admin' | 'customer' | 'guest' | 'system' | 'import'
  id: string
}

/** `applied`: the command ran and committed. `refused`: its service refused it. `replayed`: a keyed retry answered. */
export type AuditOutcome = 'applied' | 'refused' | 'replayed'

/** A record a command touched, by id only. */
export interface AuditSubject {
  type: string
  id: string
}

/**
 * One audit entry as `GET /api/admin/activity` lists it and the exports print it. A stored response is shown by its
 * status only; its body never leaves the store.
 */
export interface AuditEntry {
  id: string
  at: string
  actor: AuditActor
  command: string
  subjects: AuditSubject[]
  correlationId: string | null
  idempotencyKey: string | null
  outcome: AuditOutcome
  responseStatus: number | null
}

/** The request header an admin write carries to be applied once, and the response header a replay carries. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed'

/** 1-128 characters of `[A-Za-z0-9._:-]`. */
export function isValidIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value)
}
