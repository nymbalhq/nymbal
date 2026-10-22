import { createHash } from 'node:crypto'
import {
  IDEMPOTENCY_KEY_HEADER,
  isValidIdempotencyKey,
  type RequestContext,
  type ResponseEnvelope,
} from '@nymbalhq/types'
import type { CommandStore, Tx } from '../db/command-store.js'
import {
  appendAuditEntry,
  findAppliedByKey,
  type AppliedEntry,
} from '../repositories/audit-entry.js'
import { fail } from '../routes/envelope.js'
import type { Actor } from './actor.js'
import { entryOf, openCommand, recordRefusal, runInCommand, type CommandScope } from './audit.js'

const REPLAYED = { 'Idempotent-Replayed': 'true' }

/** The request's `Idempotency-Key`: absent, a valid key, or malformed (anything else, a repeated header included). */
export function idempotencyKeyOf(
  ctx: Pick<RequestContext, 'headers'>,
): { key: string | undefined } | { malformed: true } {
  const value = ctx.headers[IDEMPOTENCY_KEY_HEADER]
  if (value === undefined) return { key: undefined }
  return typeof value === 'string' && isValidIdempotencyKey(value)
    ? { key: value }
    : { malformed: true }
}

export function malformedKey(): ResponseEnvelope {
  return fail(
    'idempotency.key_invalid',
    'The Idempotency-Key header must be 1-128 characters of A-Z, a-z, 0-9, ".", "_", ":" and "-"',
    400,
  )
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** SHA-256 of the canonical JSON of the validated body and the path params: what a key's retries must repeat. */
export function requestHash(ctx: Pick<RequestContext, 'params' | 'body'>): string {
  return createHash('sha256')
    .update(canonical({ params: ctx.params, body: ctx.body ?? null }))
    .digest('hex')
}

const succeeded = (status: number) => status >= 200 && status < 300
const refused = (status: number) => status >= 400 && status < 500

type KeyedScope = CommandScope & { actor: Actor; command: string }

/** The answer to a key already applied: its stored response when the request is the same, else 409. */
async function answerApplied(
  tx: Tx,
  scope: KeyedScope,
  applied: AppliedEntry,
): Promise<ResponseEnvelope> {
  if (applied.requestHash !== scope.requestHash) {
    const answer = fail(
      'idempotency.key_reused',
      'This Idempotency-Key was already used with a different request',
      409,
    )
    await appendAuditEntry(tx, entryOf(scope, 'refused', { status: answer.status, subjects: [] }))
    return answer
  }
  await appendAuditEntry(
    tx,
    entryOf(scope, 'replayed', { status: applied.responseStatus, subjects: applied.subjects }),
  )
  return { status: applied.responseStatus, headers: REPLAYED, body: applied.responseBody }
}

/**
 * Runs a route's command under the request's actor, as one audited command; a refusal (a 4xx after a service ran)
 * leaves a `refused` entry.
 */
export async function auditedRoute(
  store: CommandStore,
  command: string,
  run: () => Promise<ResponseEnvelope>,
): Promise<ResponseEnvelope> {
  const scope = openCommand(command)
  const answer = await runInCommand(scope, run)
  if (refused(answer.status)) await recordRefusal(store, scope, answer.status)
  return answer
}

/**
 * Runs a keyed admin write once per actor, command and key, in one transaction: a key already applied answers its
 * stored response (or 409 for a different request) and runs nothing; otherwise the command runs and its `applied` row,
 * with the response, is appended before COMMIT. A concurrent first attempt that commits the key first makes this one's
 * insert fail on the partial unique index, which rolls this one's work back; it is then answered as a replay. A refused
 * command is never stored for replay: its retry runs again.
 */
export async function idempotentCommand(
  store: CommandStore,
  command: string,
  request: { actor: Actor; key: string; hash: string },
  run: () => Promise<ResponseEnvelope>,
): Promise<ResponseEnvelope> {
  const scope = openCommand(command, {
    owned: true,
    actor: request.actor,
    idempotencyKey: request.key,
    requestHash: request.hash,
  }) as KeyedScope
  const appliedNow = (tx: Tx) => findAppliedByKey(tx, request.actor.id, command, request.key)
  // A concurrent attempt may have applied the key while this one ran: its answer is this one's.
  const replayIfApplied = () =>
    store.transaction(async (tx) => {
      const applied = await appliedNow(tx)
      return applied === null ? null : answerApplied(tx, scope, applied)
    })

  const ran: { answer?: ResponseEnvelope } = {}
  try {
    const settled = await runInCommand(scope, () =>
      store.transaction(async (tx) => {
        const applied = await appliedNow(tx)
        if (applied !== null) return answerApplied(tx, scope, applied)
        const answer = await run()
        ran.answer = answer
        if (succeeded(answer.status)) {
          const body: unknown = JSON.parse(JSON.stringify(answer.body ?? null))
          await appendAuditEntry(tx, entryOf(scope, 'applied', { status: answer.status, body }))
        }
        return answer
      }),
    )
    if (settled !== ran.answer || succeeded(settled.status)) return settled
  } catch (err) {
    // The work rolled back: the applied row's insert lost the race, or the command threw, or answered a success its
    // transaction could not commit.
    if (ran.answer === undefined || succeeded(ran.answer.status)) {
      const replay = await replayIfApplied()
      if (replay !== null) return replay
      throw err
    }
  }
  // The command refused or faulted, its work rolled back or never written; both paths here set the answer.
  const answer = ran.answer!
  const replay = await replayIfApplied()
  if (replay !== null) return replay
  if (refused(answer.status)) await recordRefusal(store, scope, answer.status)
  return answer
}
