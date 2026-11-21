import { PROPOSAL_INTERRUPTED, PROPOSAL_OUTCOME_UNKNOWN, type Logger } from '@nymbalhq/types'
import { runAsActor } from '../audit/actor.js'
import { audit, auditedCommand } from '../audit/audit.js'
import type { CommandStore, Tx } from '../db/command-store.js'
import { runWithCorrelation } from '../events/correlation.js'
import type { EventPublisher } from '../events/publisher.js'
import { publishSettlement, runKeyOf } from '../mcp/proposals.js'
import { findAppliedByKey } from '../repositories/audit-entry.js'
import type {
  ProposalRecord,
  ProposalRepository,
  ProposalSettlement,
} from '../repositories/proposal.js'
import { routeSchemas } from '../routes/schemas.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

const COMMAND = 'proposal.sweepStuck'

export interface StuckProposalSweeperDeps {
  store: CommandStore
  proposals: ProposalRepository
  publisher: EventPublisher
  logger: Logger
  intervalMs?: number
  /** How long after its decision an `approved` row counts as stuck: long enough that no command is still running. */
  stuckAfterMs?: number
  /** Rows settled per tick, oldest decision first. */
  batchSize?: number
  now?: () => Date
}

type Verdict = Pick<ProposalSettlement, 'status' | 'outcome'>

const INTERRUPTED: Verdict = {
  status: 'failed',
  outcome: {
    status: 500,
    code: PROPOSAL_INTERRUPTED,
    message:
      'The server stopped and this did not go through. Nothing was changed; ask the agent again if you still want it.',
  },
}

const OUTCOME_UNKNOWN: Verdict = {
  status: 'failed',
  outcome: {
    status: 500,
    code: PROPOSAL_OUTCOME_UNKNOWN,
    message:
      'The server stopped while this was running, so it may or may not have gone through. Check the order or record before doing this again.',
  },
}

// What a missing `applied` entry proves depends on where the command's work commits. An admin command's commits with
// its entry; a provider command's money moves before its entry is written; a shopper route is run with no key at all.
type CommandKind = 'admin' | 'provider' | 'shopper'

function kindOfRoute(route: string, provider: true | undefined): CommandKind {
  if (provider === true) return 'provider'
  return route.split(' ')[1]!.startsWith('/api/admin/') ? 'admin' : 'shopper'
}

const KIND_BY_COMMAND = new Map<string, CommandKind>(
  Object.entries(routeSchemas).flatMap(([route, schema]): [string, CommandKind][] =>
    schema.command ? [[schema.command, kindOfRoute(route, schema.provider)]] : [],
  ),
)

async function verdictOf(tx: Tx, row: ProposalRecord): Promise<Verdict> {
  const kind = KIND_BY_COMMAND.get(row.command)
  if (kind !== 'admin' && kind !== 'provider') return OUTCOME_UNKNOWN
  // A policy's `decidedBy` is the rule's name; its run was the caller's, and the row keeps the caller as its proposer.
  const actorId = row.decidedByKind === 'admin' ? row.decidedBy : row.proposerId
  const applied =
    actorId === null ? null : await findAppliedByKey(tx, actorId, row.command, runKeyOf(row))
  if (applied !== null) return { status: 'applied', outcome: { status: applied.responseStatus } }
  return kind === 'admin' ? INTERRUPTED : OUTCOME_UNKNOWN
}

/**
 * Settles proposals left `approved` by a process that stopped between the decision and the settlement, from what the
 * store can prove. It is given no route table and no way to execute, so it can only ever settle: a refund it cannot
 * account for reads as an unknown outcome and is never sent again.
 */
export function startStuckProposalSweeper(deps: StuckProposalSweeperDeps): SweeperHandle {
  const { store, proposals, publisher } = deps
  const intervalMs = deps.intervalMs ?? 5 * 60_000
  const stuckAfterMs = deps.stuckAfterMs ?? 15 * 60_000
  const batchSize = deps.batchSize ?? 100
  const now = deps.now ?? (() => new Date())
  const logger = deps.logger.child({ sweeper: 'stuck-proposal' })
  let running = false

  // One transaction and one audit scope per row: a scope's entry is held in the first transaction it notes in, so a
  // scope over the tick would name only the first row, and a transaction over the tick would let one bad row undo all.
  const settleRow = (row: ProposalRecord): Promise<boolean> =>
    runWithCorrelation(row.correlationId, () =>
      runAsActor({ kind: 'system', id: 'proposal-sweep' }, () =>
        auditedCommand(store, COMMAND, () =>
          store.transaction(async (tx) => {
            const verdict = await verdictOf(tx, row)
            if (!(await proposals.settle(tx, row.id, { ...verdict, at: now() }))) return false
            audit.note(COMMAND, [{ type: 'proposal', id: row.id }])
            await publishSettlement(publisher, row, verdict)
            return true
          }),
        ),
      ),
    )

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const decidedBefore = new Date(now().getTime() - stuckAfterMs)
      const rows = await store.read((tx) =>
        proposals.listStuck(tx, { decidedBefore, limit: batchSize }),
      )
      let settled = 0
      for (const row of rows) {
        try {
          if (await settleRow(row)) settled += 1
        } catch (err) {
          logger.error({ err, proposalId: row.id }, 'could not settle a stuck proposal')
        }
      }
      if (settled > 0) logger.info({ settled }, 'settled stuck proposals')
    } catch (err) {
      logger.error({ err }, 'stuck proposal sweep failed')
    } finally {
      running = false
    }
  }

  const handle = setInterval(() => void tick(), intervalMs)
  handle.unref()
  return {
    tick,
    stop() {
      clearInterval(handle)
    },
  }
}
