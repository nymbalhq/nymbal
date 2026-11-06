import { v7 as uuidv7 } from 'uuid'
import {
  EVT_PROPOSAL_APPLIED,
  EVT_PROPOSAL_APPROVED,
  EVT_PROPOSAL_CREATED,
  EVT_PROPOSAL_FAILED,
  EVT_PROPOSAL_REJECTED,
  type ProposalDecider,
  type ProposalPage,
  type ProposalView,
  type RequestAuth,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore, Tx } from '../db/command-store.js'
import type { EventPublisher } from '../events/publisher.js'
import { insertOf, ProposalError, type Executed, type Proposal } from '../mcp/proposals.js'
import {
  encodeProposalCursor,
  proposalView,
  type ProposalDecision,
  type ProposalQuery,
  type ProposalRecord,
  type ProposalRepository,
} from '../repositories/proposal.js'

export interface ProposalServiceDeps {
  store: CommandStore
  proposals: ProposalRepository
  publisher: EventPublisher
  /** Runs a stored proposal's request through its route as `auth`. */
  execute(row: ProposalRecord, auth: RequestAuth | undefined): Promise<Executed>
}

export interface ProposalService {
  /** Keeps a proposal pending; a proposer's repeat under one idempotency key answers the row it already has. */
  propose(p: Proposal): Promise<ProposalView>
  /** Approves a pending proposal and runs it as the approving admin; answers the settled row. */
  approve(id: string, by: RequestAuth): Promise<ProposalView>
  reject(id: string, by: RequestAuth, reason?: string): Promise<ProposalView>
  /** Approves a pending proposal by a policy and runs it as `executor`, answering what its route answered. */
  run(id: string, by: ProposalDecider, executor: RequestAuth | undefined): Promise<Executed>
  get(id: string): Promise<ProposalView | null>
  list(q: ProposalQuery): Promise<ProposalPage>
}

const about = (row: ProposalRecord) => ({
  proposalId: row.id,
  tool: row.tool,
  command: row.command,
  proposerId: row.proposerId,
  agentName: row.agentName,
})

const adminOf = (auth: RequestAuth): ProposalDecider => ({ kind: 'admin', id: auth.userId! })

/**
 * Proposals as rows a person or a policy decides. A decision is one conditional update, so of two deciders one wins
 * and the other is told the status it lost to. The command runs between the decision and the settlement, in no
 * transaction of this service's: a provider command commits its own steps around the money it moves.
 */
export function createProposalService(deps: ProposalServiceDeps): ProposalService {
  const { store, proposals, publisher, execute } = deps

  /** Moves a pending row to the decision's status and publishes it; `command` names the audited command, if any. */
  function decide(id: string, decision: ProposalDecision, command?: string) {
    return store.transaction(async (tx) => {
      if (command !== undefined) audit.note(command, [{ type: 'proposal', id }])
      if (!(await proposals.decide(tx, id, decision))) throw await refusal(tx, id)
      const row = (await proposals.findById(tx, id))!
      const events = publisher.correlated(row.correlationId)
      const decided = { ...about(row), decidedBy: decision.by }
      await (decision.status === 'approved'
        ? events.publish(EVT_PROPOSAL_APPROVED, decided)
        : events.publish(EVT_PROPOSAL_REJECTED, { ...decided, reason: row.reason }))
      return row
    })
  }

  async function refusal(tx: Tx, id: string): Promise<ProposalError> {
    const row = await proposals.findById(tx, id)
    return row === null
      ? new ProposalError('proposal.not_found', id)
      : new ProposalError('proposal.decided', id, row.status)
  }

  async function approveAndRun(
    id: string,
    by: ProposalDecider,
    executor: RequestAuth | undefined,
    command?: string,
  ) {
    const row = await decide(id, { status: 'approved', by, at: new Date() }, command)
    const executed = await execute(row, executor)
    const applied = executed.outcome.status < 400
    const settled = await store.transaction(async (tx) => {
      await proposals.settle(tx, id, {
        status: applied ? 'applied' : 'failed',
        outcome: executed.outcome,
        at: new Date(),
      })
      const events = publisher.correlated(row.correlationId)
      await (applied
        ? events.publish(EVT_PROPOSAL_APPLIED, {
            ...about(row),
            outcome: { status: executed.outcome.status },
          })
        : events.publish(EVT_PROPOSAL_FAILED, { ...about(row), outcome: executed.outcome }))
      return (await proposals.findById(tx, id))!
    })
    return { view: proposalView(settled), executed }
  }

  return {
    async propose(p) {
      const row = await store.transaction(async (tx) => {
        const id = uuidv7()
        const insert = insertOf(p, id)
        if (!(await proposals.insert(tx, insert))) {
          return (await proposals.findByKey(
            tx,
            insert.proposerId!,
            insert.tool,
            insert.idempotencyKey!,
          ))!
        }
        const created = (await proposals.findById(tx, id))!
        await publisher.correlated(p.correlationId).publish(EVT_PROPOSAL_CREATED, about(created))
        return created
      })
      return proposalView(row)
    },

    async approve(id, by) {
      return (await approveAndRun(id, adminOf(by), by, 'proposal.approve')).view
    },

    async reject(id, by, reason) {
      const at = new Date()
      return proposalView(
        await decide(id, { status: 'rejected', by: adminOf(by), at, reason }, 'proposal.reject'),
      )
    },

    async run(id, by, executor) {
      return (await approveAndRun(id, by, executor)).executed
    },

    async get(id) {
      const row = await store.read((tx) => proposals.findById(tx, id))
      return row && proposalView(row)
    },

    async list(q) {
      return store.read(async (tx) => {
        const rows = await proposals.list(tx, { ...q, limit: q.limit + 1 })
        const items = rows.slice(0, q.limit)
        return {
          items: items.map(proposalView),
          nextCursor: rows.length > q.limit ? encodeProposalCursor(items.at(-1)!) : null,
          pending: await proposals.countPending(tx),
        }
      })
    },
  }
}
