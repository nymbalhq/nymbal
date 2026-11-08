import type { ProposalView } from './proposals.js'

/** An order or a customer a turn read: the admin shows its card, read from the store, never from the stream. */
export type AssistantRecord = { kind: 'order'; orderNumber: string } | { kind: 'customer'; id: string }

/**
 * What the admin's assistant stream sends, frame by frame: the answer's text as it arrives, one `tool` frame per tool
 * the model called (or one `proposal` frame for a write kept for a person to approve), each followed by a `record`
 * frame per order or customer it read, then `done` or `error`.
 */
export type AssistantFrame =
  | {
      event: 'text'
      /** `revealed`: where in `delta` a customer's value stands that the provider saw only as a placeholder. */
      data: {
        delta: string
        revealed?: Array<{
          start: number
          end: number
          kind: 'email' | 'phone' | 'address' | 'postcode' | 'name'
        }>
      }
    }
  | {
      event: 'tool'
      data: { name: string; title: string; ok: boolean; code?: string; applied?: true }
    }
  | { event: 'proposal'; data: ProposalView }
  | { event: 'record'; data: AssistantRecord }
  | { event: 'done'; data: { text: string; steps: number; proposals: string[] } }
  | { event: 'error'; data: { code: string; message: string } }

/** `POST /api/admin/assistant/turns`: the turn's id and the one-time ticket that opens its stream. */
export interface AssistantTurnIssued {
  turnId: string
  ticket: string
  expiresIn: number
}
