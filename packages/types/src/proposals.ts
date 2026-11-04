/** Where an agent's write stands: waiting, decided, then run. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'

/** Who decided a proposal: an admin, or a policy the store's config sets. */
export type ProposalDecider =
  | { kind: 'admin'; id: string }
  | { kind: 'policy'; rule: 'agents.mcp.writes' | 'agents.autoApprove' }

/** One proposal as the admin reads it. A handle's value (a cart id) is never served: only its argument's name. */
export interface ProposalView {
  id: string
  tool: string
  title: string
  command: string
  /** The arguments the agent sent, less its idempotency key and its handles. */
  args: Record<string, unknown>
  handles: string[]
  idempotencyKey: string | null
  status: ProposalStatus
  proposer: { userId: string | null; agent: { name: string; version?: string } }
  correlationId: string
  createdAt: string
  decision?: { by: ProposalDecider; at: string; reason?: string }
  /** What the route answered when the proposal ran. */
  outcome?: { status: number; code?: string; message?: string }
}

export interface ProposalPage {
  items: ProposalView[]
  nextCursor: string | null
  /** Every proposal still waiting for a decision, whatever the page holds. */
  pending: number
}
