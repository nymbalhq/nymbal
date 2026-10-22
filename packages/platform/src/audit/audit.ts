import { AsyncLocalStorage } from 'node:async_hooks'
import { v7 as uuidv7 } from 'uuid'
import type { AuditOutcome, AuditSubject } from '@nymbalhq/types'
import {
  afterCommit,
  beforeCommit,
  openTransaction,
  type CommandStore,
  type Tx,
} from '../db/command-store.js'
import { currentCorrelationId } from '../events/correlation.js'
import { appendAuditEntry, type AuditEntryInsert } from '../repositories/audit-entry.js'
import { renderError } from '../routes/envelope.js'
import { currentActor, type Actor } from './actor.js'

// One audit row per outermost command. The opener (a route, a sweep, an import) opens the command's scope; services
// only note the command they run and the records it touches, and write no row. A nested service call notes into the
// same scope, so a checkout's reservations are subjects of its one entry.
//
// The `applied` row is held in the first transaction a service notes in and commits or rolls back with it, so a
// rolled-back write leaves no entry. A keyed admin write is the exception: its opener runs the whole command in one
// transaction and appends the row itself, with the response its replays answer (idempotency.ts).

/** The open command: what its entry will say. */
export interface CommandScope {
  command: string | undefined
  /** Whoever is acting when a service first notes: a webhook runs as the system inside its request's guest scope. */
  actor: Actor | undefined
  readonly correlationId: string | null
  readonly subjects: Map<string, AuditSubject>
  /** A service has run for this command: only then is a refusal the command's. */
  noted: boolean
  /** The opener appends the row itself; notes only collect. */
  readonly owned: boolean
  readonly idempotencyKey: string | null
  readonly requestHash: string | null
  /** The transaction the `applied` row is held in, and whether that transaction committed. */
  heldIn: object | undefined
  written: boolean
}

const scopes = new AsyncLocalStorage<CommandScope>()
/** Commands opened by a note itself, one per transaction: work under an actor that no opener scoped. */
const byTransaction = new WeakMap<object, CommandScope>()

export function openCommand(
  command: string | undefined,
  opts: { owned?: boolean; actor?: Actor; idempotencyKey?: string; requestHash?: string } = {},
): CommandScope {
  return {
    command,
    actor: opts.actor,
    correlationId: currentCorrelationId() ?? null,
    subjects: new Map(),
    noted: false,
    owned: opts.owned ?? false,
    idempotencyKey: opts.idempotencyKey ?? null,
    requestHash: opts.requestHash ?? null,
    heldIn: undefined,
    written: false,
  }
}

export function runInCommand<T>(scope: CommandScope, fn: () => T): T {
  return scopes.run(scope, fn)
}

/** Runs `fn` outside any command: for work done on behalf of other operations, such as relay delivery. */
export function outsideCommand<T>(fn: () => T): T {
  return scopes.exit(fn)
}

export function entryOf(
  scope: CommandScope & { actor: Actor; command: string },
  outcome: AuditOutcome,
  response: { status: number | null; body?: unknown; subjects?: AuditSubject[] } = { status: null },
): AuditEntryInsert {
  return {
    id: uuidv7(),
    at: new Date(),
    actor: scope.actor,
    command: scope.command,
    subjects: response.subjects ?? [...scope.subjects.values()],
    correlationId: scope.correlationId,
    idempotencyKey: scope.idempotencyKey,
    requestHash: scope.requestHash,
    outcome,
    responseStatus: response.status,
    responseBody: response.body ?? null,
  }
}

function complete(scope: CommandScope): scope is CommandScope & { actor: Actor; command: string } {
  return scope.actor !== undefined && scope.command !== undefined
}

/** Holds the scope's `applied` row in the transaction open now, unless it already is or has committed. */
function hold(scope: CommandScope): void {
  if (scope.owned || scope.written || !complete(scope)) return
  const tx = openTransaction()
  if (tx === undefined || tx === scope.heldIn) return
  scope.heldIn = tx
  beforeCommit(async (held: Tx) => {
    if (!scope.written && complete(scope)) await appendAuditEntry(held, entryOf(scope, 'applied'))
  })
  void afterCommit(async () => {
    scope.written = true
  })
}

function record(
  scope: CommandScope,
  command: string,
  subjects: readonly AuditSubject[],
): CommandScope {
  scope.command ??= command
  scope.actor ??= currentActor()
  for (const subject of subjects) scope.subjects.set(`${subject.type}:${subject.id}`, subject)
  scope.noted = true
  hold(scope)
  return scope
}

export const audit = {
  /**
   * A service names the command it runs and the records it touches. It writes nothing itself: the open command's
   * entry carries them. Call it before the command can refuse, so a refusal is recorded as the command's.
   */
  note(command: string, subjects: readonly AuditSubject[] = []): void {
    const open = scopes.getStore()
    if (open !== undefined) {
      record(open, command, subjects)
      return
    }
    // No opener: under an actor (an import), each transaction a service notes in is a command of its own. With no
    // actor (seeding, a projection, a test calling a service) nothing is recorded.
    const tx = openTransaction()
    if (tx === undefined || currentActor() === undefined) return
    const own = byTransaction.get(tx) ?? openCommand(undefined)
    byTransaction.set(tx, own)
    record(own, command, subjects)
  },
}

/** Appends the scope's `refused` entry, in a transaction of its own, when a service ran and nothing was applied. */
export async function recordRefusal(
  store: CommandStore,
  scope: CommandScope,
  status: number,
): Promise<void> {
  if (!scope.noted || scope.written || !complete(scope)) return
  await store.transaction((tx) => appendAuditEntry(tx, entryOf(scope, 'refused', { status })))
}

/** The status an error answers when it is the caller's to fix (a refusal), else null (a fault). */
function refusalStatus(err: unknown): number | null {
  const { status } = renderError(err)
  return status >= 400 && status < 500 ? status : null
}

/**
 * Runs `fn` as one command, `command` (or, when undefined, the first command a service notes). Inside an open command
 * it joins that one. A refusal thrown out of `fn` is recorded as the command's `refused` entry.
 */
export async function auditedCommand<T>(
  store: CommandStore,
  command: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (scopes.getStore() !== undefined) return fn()
  const scope = openCommand(command)
  try {
    return await runInCommand(scope, fn)
  } catch (err) {
    const status = refusalStatus(err)
    if (status !== null) await recordRefusal(store, scope, status)
    throw err
  }
}
