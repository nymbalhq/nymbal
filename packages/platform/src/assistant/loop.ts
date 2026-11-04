import {
  NymbalError,
  type AiAdapter,
  type AssistantFrame,
  type Caller,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ChatStreamEvent,
  type ChatTool,
  type Logger,
  type ToolDefinition,
  type ToolResult,
  type ToolSurface,
} from '@nymbalhq/types'
import { routeSchemas } from '../routes/schemas.js'
import type { ProposalService } from '../services/proposal-service.js'

/** The agent name every tool call, proposal and audit entry of the assistant carries. */
export const ASSISTANT_AGENT = 'nymbal-assistant'

const DEFAULT_LIMITS = { maxSteps: 8, turnMs: 60_000, resultChars: 16_000 }
/** Calls past this many in one reply are answered as refused, not run. */
const MAX_CALLS_PER_REPLY = 10
/** Tool results sent to the model in one turn; past it a call is answered as refused, not run. */
const RESULT_BUDGET_CHARS = 64_000

export interface AssistantDeps {
  ai: AiAdapter
  /** The tools as the assistant runs them: writes become proposals unless `agents.autoApprove` lists them. */
  tools: ToolSurface
  proposals: Pick<ProposalService, 'get'>
  logger: Logger
  /** The store's name and currency, for the model's instructions. */
  store?: { name: string; currency: string }
  limits?: { maxSteps?: number; turnMs?: number; resultChars?: number }
}

export interface AssistantTurn {
  /** The signed-in admin, as agent `nymbal-assistant`. */
  caller: Caller
  /** The conversation so far as the admin's browser holds it; the last turn is the question. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** The admin route the panel was opened on, e.g. `/products/ceramic-mug`. */
  page?: string
}

type Stream = NonNullable<AiAdapter['chatStream']>

const withCalls = (result: ChatResult): ChatResult => ({
  ...result,
  toolCalls: result.toolCalls ?? [],
})

/**
 * The adapter's own `chatStream`, or for an adapter with only `chat` its answer as one text event, its calls and
 * `done`, so an ai adapter that cannot stream still runs the assistant. A result without `toolCalls` (an adapter of the
 * older contract) is read as one with none.
 */
export function streamOf(ai: AiAdapter): Stream {
  const own = ai.chatStream?.bind(ai)
  if (own !== undefined) {
    return async function* (messages, opts) {
      for await (const event of own(messages, opts)) {
        yield event.type === 'done' ? { type: 'done', result: withCalls(event.result) } : event
      }
    }
  }
  return async function* (messages, opts) {
    const result = withCalls(await ai.chat(messages, opts))
    if (result.text !== '') yield { type: 'text', delta: result.text }
    for (const call of result.toolCalls) yield { type: 'tool_call', call }
    yield { type: 'done', result }
  }
}

/**
 * The tools the model is offered: the admin's own, and the catalogue reads anyone may make. A cart or checkout tool
 * (one that takes a handle), a customer's own tools and any other write are left out.
 */
export function assistantTools(listed: readonly ToolDefinition[]): ToolDefinition[] {
  return listed.filter((tool) => {
    const entry = routeSchemas[`${tool.route.method} ${tool.route.path}`]
    if (Object.keys(entry?.handles ?? {}).length > 0) return false
    return tool.scope === 'admin' || (tool.scope === 'public' && tool.kind === 'read')
  })
}

function systemPrompt(store: AssistantDeps['store'], page: string | undefined): string {
  return [
    store === undefined
      ? "You are the store's assistant, inside its admin."
      : `You are the assistant of the store ${store.name}, inside its admin. Its currency is ${store.currency}.`,
    'Money in the tools is in minor units: 1900 is 19.00.',
    ...(page === undefined ? [] : [`The merchant is looking at the admin page ${page}.`]),
    "Answer from the store's tools, never from a guess; say so when the tools cannot tell you.",
    'A write you call does not change the store: it becomes a proposal that a person approves or rejects in the inbox. Say that it waits for their approval.',
    'You cannot approve or reject proposals, and you cannot read or change secrets, keys or settings.',
    'Answer briefly.',
  ].join('\n')
}

/** Raised inside the loop when its signal aborts: the turn stops where it is. */
class Stopped extends Error {}

/** `promise`, or Stopped once `signal` aborts; the promise left behind is caught, so its rejection is not unhandled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined)
    return Promise.reject(new Stopped())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Stopped())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * A result cut to `max` characters, with a note saying how much the model does not see. A list keeps its leading
 * items whole and says in a `cut` field how many it left out, so what the model reads is still JSON; any other result
 * keeps its first `max` characters.
 */
function cut(result: ToolResult, max: number): string {
  const text = result.content[0]?.text ?? ''
  if (text.length <= max) return text
  const { items, ...rest } = result.structuredContent ?? {}
  if (Array.isArray(items)) {
    const fits = (n: number) => JSON.stringify({ ...rest, items: items.slice(0, n) }).length <= max
    let kept = 0
    while (kept < items.length && fits(kept + 1)) kept += 1
    return JSON.stringify({
      ...rest,
      items: items.slice(0, kept),
      cut: `${items.length - kept} of ${items.length} items not shown: ask for fewer`,
    })
  }
  return `${text.slice(0, max)}\n[cut: ${text.length - max} of ${text.length} characters not shown]`
}

const refusalText = (code: string, message: string) => JSON.stringify({ code, message })

/**
 * One assistant turn: the model is called with the store's tools, each tool it asks for runs through the tool surface
 * as the admin, and its result goes back to it, until it answers without calls. `emit` receives every frame; the turn
 * ends with one `done` or one `error` frame, or with none when `signal` aborts (the merchant has gone). It is bounded by
 * `maxSteps` model requests, `turnMs`, ten calls per reply and 64 000 characters of results.
 */
export async function runAssistantTurn(
  deps: AssistantDeps,
  turn: AssistantTurn,
  emit: (frame: AssistantFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits }
  const log = deps.logger.child({ agent: ASSISTANT_AGENT })
  const controller = new AbortController()
  const stopped = controller.signal
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, limits.turnMs)
  const onAbort = () => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const offered = assistantTools(deps.tools.list(turn.caller))
  const byName = new Map(offered.map((tool) => [tool.name, tool]))
  const tools: ChatTool[] = offered.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
  const opts: ChatOptions = {
    system: systemPrompt(deps.store, turn.page),
    tools,
    signal: stopped,
  }
  const stream = streamOf(deps.ai)
  const messages: ChatMessage[] = turn.messages.map((m) => ({ role: m.role, content: m.content }))
  const proposals: string[] = []
  let used = 0
  let steps = 0
  let outcome = 'done'

  const refuse = (name: string, title: string, code: string, message: string) => {
    emit({ event: 'tool', data: { name, title, ok: false, code } })
    return { content: refusalText(code, message), isError: true }
  }

  async function reply(): Promise<ChatResult> {
    const iterator = stream(messages, opts)[Symbol.asyncIterator]()
    try {
      for (;;) {
        const next = await abortable(iterator.next(), stopped)
        if (next.done === true) {
          throw new NymbalError('assistant.failed', 'The model answered no result')
        }
        const event: ChatStreamEvent = next.value
        if (event.type === 'text' && event.delta !== '') {
          emit({ event: 'text', data: { delta: event.delta } })
        } else if (event.type === 'done') {
          return event.result
        }
      }
    } finally {
      // Reading stopped on an abort as on a `done`: closing the iterator closes a request still open.
      iterator.return?.()?.catch(() => undefined)
    }
  }

  async function run(
    call: ChatResult['toolCalls'][number],
    index: number,
  ): Promise<{ content: string; isError: boolean }> {
    const tool = byName.get(call.name)
    const title = tool?.title ?? call.name
    if (index >= MAX_CALLS_PER_REPLY) {
      return refuse(
        call.name,
        title,
        'assistant.too_many_calls',
        `At most ${MAX_CALLS_PER_REPLY} tool calls of one reply are run; ask for this one again`,
      )
    }
    if (used >= RESULT_BUDGET_CHARS) {
      return refuse(
        call.name,
        title,
        'assistant.budget_exhausted',
        'This turn has read as much as it may; answer with what it has',
      )
    }
    // A tool the model was not offered is one it cannot call, whatever the surface would run.
    if (tool === undefined) {
      return refuse(call.name, title, 'tool.unknown', `No tool is named ${call.name}`)
    }
    const result = await deps.tools.call(call.name, call.args, turn.caller)
    const isError = result.isError === true
    const structured = result.structuredContent ?? {}
    const command = tool.kind === 'command'
    if (!isError && command && structured['status'] === 'proposed') {
      const id = structured['id']
      const view = typeof id === 'string' ? await deps.proposals.get(id) : null
      if (view === null) {
        emit({
          event: 'tool',
          data: { name: call.name, title, ok: false, code: 'proposal.not_kept' },
        })
      } else {
        proposals.push(view.id)
        emit({ event: 'proposal', data: view })
      }
    } else {
      const code = structured['code']
      emit({
        event: 'tool',
        data: {
          name: call.name,
          title,
          ok: !isError,
          ...(isError && typeof code === 'string' && { code }),
          ...(!isError && command && { applied: true as const }),
        },
      })
    }
    const content = cut(result, limits.resultChars)
    used += content.length
    return { content, isError }
  }

  try {
    for (;;) {
      steps += 1
      const result = await reply()
      if (result.toolCalls.length === 0) {
        emit({ event: 'done', data: { text: result.text, steps, proposals } })
        return
      }
      if (steps >= limits.maxSteps) {
        outcome = 'assistant.step_limit'
        emit({
          event: 'error',
          data: {
            code: outcome,
            message: `The assistant stopped after ${limits.maxSteps} model requests without an answer`,
          },
        })
        return
      }
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })
      for (const [index, call] of result.toolCalls.entries()) {
        if (stopped.aborted) throw new Stopped()
        const answered = await run(call, index)
        messages.push({ role: 'tool', toolCallId: call.id, ...answered })
      }
    }
  } catch (error) {
    if (timedOut) {
      outcome = 'assistant.timeout'
      emit({
        event: 'error',
        data: { code: outcome, message: `The assistant took longer than ${limits.turnMs} ms` },
      })
    } else if (signal?.aborted === true) {
      outcome = 'stopped'
    } else if (error instanceof NymbalError) {
      outcome = error.code
      emit({ event: 'error', data: { code: error.code, message: error.message } })
    } else {
      outcome = 'assistant.failed'
      log.error({ name: (error as Error | null)?.name }, 'assistant turn failed')
      emit({ event: 'error', data: { code: outcome, message: 'The assistant failed' } })
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    log.info({ steps, proposals: proposals.length, outcome }, 'assistant turn ended')
  }
}
