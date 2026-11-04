import type { NymbalConfig } from '@nymbalhq/config'
import {
  ConfigError,
  NymbalError,
  type Caller,
  type ProposalDecider,
  type ProposalStatus,
  type ToolResult,
} from '@nymbalhq/types'
import type { ProposalInsert } from '../repositories/proposal.js'
import { routeSchemas } from '../routes/schemas.js'

/** A command tool's call, admitted by its route's gate and schema, as the proposal it is kept as. */
export interface Proposal {
  tool: string
  command: string
  /** The arguments as sent, less the idempotency key and the handles. */
  args: Record<string, unknown>
  /** Argument name to value, for the handles the call carried (a cart). */
  handles?: Record<string, string>
  idempotencyKey?: string
  caller: Caller
  correlationId: string
  at: string
}

/** What a proposal's route answered when it ran: the tool's result, and the status and error it was answered with. */
export interface Executed {
  result: ToolResult
  outcome: { status: number; code?: string; message?: string }
}

/** Who approves a command at the call, or null when an admin must. */
export type Policy = (command: string) => ProposalDecider | null

/** A proposal that does not exist (404), or one already decided (409, with its status). */
export class ProposalError extends NymbalError {
  readonly status: 404 | 409

  constructor(
    code: 'proposal.not_found' | 'proposal.decided',
    id: string,
    status?: ProposalStatus,
  ) {
    super(
      code,
      status === undefined ? `No proposal ${id}` : `Proposal ${id} is already ${status}`,
      { context: status === undefined ? { id } : { id, status } },
    )
    this.status = status === undefined ? 404 : 409
  }
}

export function insertOf(p: Proposal, id: string): ProposalInsert {
  return {
    id,
    tool: p.tool,
    command: p.command,
    args: p.args,
    handles: p.handles ?? null,
    idempotencyKey: p.idempotencyKey ?? null,
    proposerId: p.caller.auth?.userId ?? null,
    agentName: p.caller.agent.name,
    agentVersion: p.caller.agent.version ?? null,
    correlationId: p.correlationId,
    createdAt: new Date(p.at),
  }
}

/**
 * The policy `agents` sets. `writes: 'apply'` approves every command; `autoApprove` the commands it names, each of
 * which must be a route's command that moves no money (`provider`), or createApp stops.
 */
export function policyOf(agents: NymbalConfig['agents']): Policy {
  const moves = new Map<string, boolean>()
  for (const entry of Object.values(routeSchemas)) {
    if (typeof entry.command !== 'string') continue
    moves.set(entry.command, moves.get(entry.command) === true || entry.provider === true)
  }
  agents.autoApprove.forEach((command, i) => {
    const provider = moves.get(command)
    if (provider === undefined) {
      throw new ConfigError(
        `agents.autoApprove[${i}]: no route runs a command named "${command}"`,
        {
          code: 'config.auto_approve_unknown',
          context: { command },
        },
      )
    }
    if (provider) {
      throw new ConfigError(
        `agents.autoApprove[${i}]: "${command}" moves money through the payments provider, so an admin approves it; only agents.mcp.writes 'apply' runs it at the call`,
        { code: 'config.auto_approve_money', context: { command } },
      )
    }
  })
  if (agents.mcp.writes === 'apply') return () => ({ kind: 'policy', rule: 'agents.mcp.writes' })
  const listed = new Set(agents.autoApprove)
  return (command) => (listed.has(command) ? { kind: 'policy', rule: 'agents.autoApprove' } : null)
}
