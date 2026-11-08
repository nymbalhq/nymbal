import { createHash } from 'node:crypto'
import type { Caller, ChatTool, ToolSurface } from '@nymbalhq/types'
import { ASSISTANT_AGENT, assistantTools, chatToolsOf, systemPrompt } from './loop.js'

// The eval stamp: a hash of what the model is sent, so a change to the assistant's instructions or to the tools it is
// offered is seen as one that no eval run has scored yet. The store, page and caller are fixed: the hash moves with
// the prompt's wording and the tools' definitions, never with a store's own name or data, nor with the day.

/** The store the stamped prompt names. */
export const EVAL_STAMP_STORE = {
  name: 'Nymbal Eval',
  currency: 'GBP',
  timezone: 'Europe/London',
} as const
/** The instant the stamped prompt is dated: midday UTC, Saturday 7 November 2026. */
export const EVAL_STAMP_TODAY = Date.parse('2026-11-07T12:00:00Z')
/** A page with a parameter, so the prompt names it and the page read is offered. */
export const EVAL_STAMP_PAGE = '/orders/:orderNumber'

const ADMIN: Caller = {
  auth: { userId: 'assistant-eval-stamp', roles: ['admin'] },
  agent: { name: ASSISTANT_AGENT },
}

/** A record of the last real eval run, as `nymbal eval assistant --stamp` writes it. */
export interface AssistantEvalStamp {
  hash: string
  /** `pending` until a run against a real provider records one. */
  provider: string
  model: string | null
  runs: number | null
  passed: number | null
  total: number | null
  threshold: number | null
  /** The day of the run, `YYYY-MM-DD`. */
  date: string | null
}

export interface AssistantEvalInput {
  /** The system prompt with customer details masked (the default) and with masking off. */
  prompts: { masked: string; plain: string }
  /** The tools an admin's assistant is offered, by name. */
  tools: ChatTool[]
}

/** What the model receives on the fixed page for an admin, with every customer tool on (the default). */
export function assistantEvalInput(surface: Pick<ToolSurface, 'list'>): AssistantEvalInput {
  const offered = assistantTools(surface.list(ADMIN), { customerData: true })
  return {
    prompts: {
      masked: systemPrompt(EVAL_STAMP_STORE, EVAL_STAMP_PAGE, true, EVAL_STAMP_TODAY),
      plain: systemPrompt(EVAL_STAMP_STORE, EVAL_STAMP_PAGE, false, EVAL_STAMP_TODAY),
    },
    tools: chatToolsOf(offered, true).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, sorted(record[key])]),
  )
}

/** JSON with every object's keys sorted, so the same value serialises the same whatever order it was built in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value))
}

/** The hash of `assistantEvalInput`, as the stamp records it. */
export function assistantEvalHash(surface: Pick<ToolSurface, 'list'>): string {
  const digest = createHash('sha256').update(canonicalJson(assistantEvalInput(surface)))
  return `sha256:${digest.digest('hex')}`
}
