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
  /** What a pending write would change, read from the store when the proposal is read on its own. */
  preview?: ProposalPreview
}

/** The commands whose pending proposal, read on its own, carries a preview. */
export const PREVIEWED_COMMANDS: readonly string[] = [
  'product.update',
  'inventory.adjust',
  'order.refund',
  'order.cancel',
]

/** One value a pending write changes, as it is now beside what the write would make it. */
export interface ProposalChange {
  /** What changes, as the admin reads it: "Name", "Price of Large", "Stock", "Refunded", "Status", "Media". */
  label: string
  /** `money`: minor units of `ProposalPreview.currency`; `collection`: item or key counts, with `changed`. */
  kind: 'value' | 'money' | 'collection'
  current: string | number | null
  proposed: string | number | null
  changed?: boolean
}

/** What a pending write acts on and what it changes there. */
export interface ProposalPreview {
  /** What the write acts on, read from the store now; null when the id names nothing. */
  target: { kind: 'product' | 'variant' | 'order'; id: string; label: string } | null
  changes: ProposalChange[]
  currency: string
}

export interface ProposalPage {
  items: ProposalView[]
  nextCursor: string | null
  /** Every proposal still waiting for a decision, whatever the page holds. */
  pending: number
}
