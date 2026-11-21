import { randomUUID } from 'node:crypto'
import {
  EVT_PROPOSAL_APPLIED,
  EVT_PROPOSAL_FAILED,
  type Logger,
  type ProposalDecider,
  type ProposalStatus,
} from '@nymbalhq/types'
import type { CommandStore } from '../../src/db/command-store.js'
import type { EventPublisher } from '../../src/events/publisher.js'
import { appendAuditEntry } from '../../src/repositories/audit-entry.js'
import type { ProposalRecord, ProposalRepository } from '../../src/repositories/proposal.js'
import * as sweepers from '../../src/sweepers/index.js'
import type { SweeperHandle } from '../../src/sweepers/index.js'
import { eventRows, type EventRow } from './outbox.js'
import type { RawReader } from './raw.js'
import { unaudited } from './write-audit.js'

// Proposals as a process that stopped between the decision and the settlement leaves them, the evidence a run leaves
// in the audit log, and a sweeper over them on a clock the test sets. Rows and entries go in through the repositories,
// so a row is what the running service would have written.

export const NOW = new Date('2026-11-09T12:00:00.000Z')
export const BOUND_MS = 15 * 60_000
export const STUCK_AT = new Date(NOW.getTime() - BOUND_MS - 60_000)

export const INTERRUPTED_CODE = 'proposal.interrupted'
export const UNKNOWN_CODE = 'proposal.outcome_unknown'
export const INTERRUPTED_TEXT =
  'The server stopped and this did not go through. Nothing was changed; ask the agent again if you still want it.'
export const UNKNOWN_TEXT =
  'The server stopped while this was running, so it may or may not have gone through. Check the order or record before doing this again.'

/** The admin who approved a row, and the one its agent signed in as: different people, so a read of the wrong one misses. */
export const APPROVER = 'admin-approver'
export const PROPOSER = 'admin-proposer'

export interface StuckSweeperDeps {
  store: CommandStore
  proposals: ProposalRepository
  publisher: EventPublisher
  logger: Logger
  intervalMs?: number
  stuckAfterMs?: number
  batchSize?: number
  now?: () => Date
}

// Read off the module so that a store without the sweeper leaves every row approved and the assertions report it.
const startSweeper = (
  sweepers as unknown as {
    startStuckProposalSweeper?: (deps: StuckSweeperDeps) => SweeperHandle
  }
).startStuckProposalSweeper

export function sweeperWith(deps: StuckSweeperDeps): SweeperHandle {
  if (startSweeper === undefined) return { tick: () => Promise.resolve(), stop: () => undefined }
  return startSweeper({ intervalMs: 3_600_000, now: () => NOW, ...deps })
}

type StoreSide = {
  store: CommandStore
  repos: { proposal: ProposalRepository }
}

export interface RowSeed {
  command: string
  decidedAt?: Date
  status?: ProposalStatus
  decider?: ProposalDecider
  proposerId?: string | null
  idempotencyKey?: string | null
}

/** A row as the machine leaves it: `approved` and unsettled by default, decided at `decidedAt`. */
export async function seedRow(side: StoreSide, seed: RowSeed): Promise<ProposalRecord> {
  const { store } = side
  const proposals = side.repos.proposal
  const id = randomUUID()
  const status = seed.status ?? 'approved'
  const decidedAt = seed.decidedAt ?? STUCK_AT
  await unaudited(() =>
    store.transaction(async (tx) => {
      await proposals.insert(tx, {
        id,
        tool: seed.command.replace('.', '_'),
        command: seed.command,
        args: {},
        handles: null,
        idempotencyKey: seed.idempotencyKey ?? null,
        proposerId: seed.proposerId === undefined ? PROPOSER : seed.proposerId,
        agentName: 'sweep-suite-agent',
        agentVersion: null,
        correlationId: randomUUID(),
        createdAt: new Date(decidedAt.getTime() - 1_000),
      })
      if (status === 'pending') return
      await proposals.decide(tx, id, {
        status: status === 'rejected' ? 'rejected' : 'approved',
        by: seed.decider ?? { kind: 'admin', id: APPROVER },
        at: decidedAt,
      })
      if (status === 'applied' || status === 'failed') {
        await proposals.settle(tx, id, {
          status,
          outcome: { status: status === 'applied' ? 200 : 409 },
          at: decidedAt,
        })
      }
    }),
  )
  return readRow(side, id)
}

export async function readRow(side: StoreSide, id: string): Promise<ProposalRecord> {
  const row = await side.store.read((tx) => side.repos.proposal.findById(tx, id))
  if (row === null) throw new Error(`no proposal ${id}`)
  return row
}

export interface EntrySeed {
  actorKind?: 'admin' | 'customer' | 'guest' | 'system'
  actorId?: string
  command?: string
  idempotencyKey?: string | null
  correlationId?: string | null
  outcome?: 'applied' | 'refused'
  responseStatus?: number
}

/** The entry the run a row asked for left: by default its approving admin's, `applied`, under the proposal's key. */
export async function recordEntry(
  side: StoreSide,
  row: ProposalRecord,
  entry: EntrySeed = {},
): Promise<void> {
  await unaudited(() =>
    side.store.transaction(async (tx) => {
      await appendAuditEntry(tx, {
        id: randomUUID(),
        at: new Date(STUCK_AT.getTime() + 1_000),
        actor: { kind: entry.actorKind ?? 'admin', id: entry.actorId ?? APPROVER },
        command: entry.command ?? row.command,
        subjects: [],
        correlationId:
          entry.correlationId === undefined ? row.correlationId : entry.correlationId,
        idempotencyKey:
          entry.idempotencyKey === undefined
            ? (row.idempotencyKey ?? `proposal:${row.id}`)
            : entry.idempotencyKey,
        requestHash: null,
        outcome: entry.outcome ?? 'applied',
        responseStatus: entry.responseStatus ?? 200,
        responseBody: null,
      })
    }),
  )
}

/** The `proposal.applied.v1` and `proposal.failed.v1` rows the log holds for one proposal. */
export async function settledEvents(raw: RawReader, proposalId: string): Promise<EventRow[]> {
  const rows = await eventRows(raw, 'type IN (?, ?)', [EVT_PROPOSAL_APPLIED, EVT_PROPOSAL_FAILED])
  return rows.filter((row) => (row.envelope.payload as { proposalId: string }).proposalId === proposalId)
}

export interface RecordingLogger extends Logger {
  /** What was logged at `warn` or `error`, oldest first, as text. */
  problems: string[]
}

export function recordingLogger(): RecordingLogger {
  const problems: string[] = []
  // An Error's own fields are not enumerable: its message is kept so an assertion can read which row it named.
  const readable = (_key: string, value: unknown) =>
    value instanceof Error ? { name: value.name, message: value.message } : value
  const keep = (entry: unknown, msg?: string) =>
    problems.push(`${JSON.stringify(entry, readable)} ${msg ?? ''}`)
  const logger: RecordingLogger = {
    problems,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: keep,
    error: keep,
    child: () => logger,
  }
  return logger
}
