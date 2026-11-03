import type { Caller, Logger } from '@nymbalhq/types'

/** A command tool's call held back under `agents.mcp.writes: 'proposal'`: validated, admitted by the gate, not run. */
export interface Proposal {
  tool: string
  command: string
  input: Record<string, unknown>
  caller: Caller
  correlationId: string
  at: string
}

export interface ProposalSink {
  propose(p: Proposal): Promise<{ id: string | null }>
}

/** Keeps nothing: the proposal is logged with its correlation id and answered without an id. */
export function returningSink(logger: Logger): ProposalSink {
  return {
    async propose(p) {
      logger.info(
        {
          tool: p.tool,
          command: p.command,
          correlationId: p.correlationId,
          userId: p.caller.auth?.userId,
          agent: p.caller.agent,
        },
        'agent proposal',
      )
      return { id: null }
    },
  }
}
