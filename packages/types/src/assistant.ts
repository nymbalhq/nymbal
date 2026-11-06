import type { ProposalView } from './proposals.js'

/**
 * What the admin's assistant stream sends, frame by frame: the answer's text as it arrives, one `tool` frame per tool
 * the model called (or one `proposal` frame for a write kept for a person to approve), then `done` or `error`.
 */
export type AssistantFrame =
  | { event: 'text'; data: { delta: string } }
  | {
      event: 'tool'
      data: { name: string; title: string; ok: boolean; code?: string; applied?: true }
    }
  | { event: 'proposal'; data: ProposalView }
  | { event: 'done'; data: { text: string; steps: number; proposals: string[] } }
  | { event: 'error'; data: { code: string; message: string } }

/** `POST /api/admin/assistant/turns`: the turn's id and the one-time ticket that opens its stream. */
export interface AssistantTurnIssued {
  turnId: string
  ticket: string
  expiresIn: number
}
