import type {
  AiAdapter,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatStopReason,
  ChatStreamEvent,
  ChatToolCall,
  Logger,
} from '@nymbalhq/types'
import { AdapterError } from '@nymbalhq/types'
import {
  bodyText,
  brokenOff,
  callOf,
  checkChat,
  DEFAULT_TIMEOUT_MS,
  isRecord,
  jsonOf,
  lifetime,
  post,
  recOf,
  unreadable,
  type Lifetime,
} from './chat.js'
import { sseEvents, type SseEvent } from './sse.js'

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const OPENAI_HOST = 'api.openai.com'

/** The request field that bounds the answer's length. */
export type TokenField = 'max_tokens' | 'max_completion_tokens'

export interface OpenAiAdapterConfig {
  apiKey: string
  /** The model the server serves, sent with every request. */
  model: string
  /** Where the chat completions API is, its path prefix included; OpenAI's own when omitted. */
  baseUrl?: string
  /**
   * `max_completion_tokens` on OpenAI's own host, whose newer models refuse `max_tokens`; `max_tokens` on any other
   * (a compatible server may know only that one) when omitted.
   */
  tokenField?: TokenField
  /** How long one chat() waits for its answer, or one chatStream() for its end; 60 000 when omitted. */
  timeoutMs?: number
  logger: Logger
}

const PROVIDER = 'openai'

function stopReasonOf(wire: unknown): ChatStopReason {
  if (wire === 'stop') return 'end'
  if (wire === 'length') return 'max_tokens'
  if (wire === 'tool_calls') return 'tool_use'
  return 'other'
}

const count = (value: unknown): number => (typeof value === 'number' ? value : 0)

const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).hostname : '')

/** The conversation as OpenAI's messages: calls as `tool_calls` with JSON-string arguments, tool turns as `tool`. */
function wireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    const calls = m.role === 'assistant' ? (m.toolCalls ?? []) : []
    if (calls.length === 0) return { role: m.role, content: m.content }
    return {
      role: m.role,
      content: m.content === '' ? null : m.content,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    }
  })
}

/** A call from the wire, its arguments a JSON text; undefined when it is not one the adapter can read. */
function wireCallOf(id: unknown, name: unknown, args: unknown): ChatToolCall | undefined {
  return callOf(id, name, typeof args === 'string' ? jsonOf(args) : undefined)
}

export function createOpenAiAdapter(config: OpenAiAdapterConfig): AiAdapter {
  const base = config.baseUrl ?? DEFAULT_BASE_URL
  const url = `${base.endsWith('/') ? base.slice(0, -1) : base}/chat/completions`
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ownHost = hostOf(base) === OPENAI_HOST
  const tokenField = config.tokenField ?? (ownHost ? 'max_completion_tokens' : 'max_tokens')
  const headers = { authorization: `Bearer ${config.apiKey}` }

  function requestOf(
    messages: readonly ChatMessage[],
    opts: ChatOptions | undefined,
    stream: boolean,
  ): string {
    const maxTokens = checkChat(PROVIDER, messages, opts)
    const system = opts?.system
    const tools = opts?.tools ?? []
    return JSON.stringify({
      model: config.model,
      [tokenField]: maxTokens,
      messages: [
        ...(system !== undefined && system !== '' ? [{ role: 'system', content: system }] : []),
        ...wireMessages(messages),
      ],
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
      // Usage on a stream is OpenAI's own option; a compatible server may refuse it.
      ...(stream && { stream: true, ...(ownHost && { stream_options: { include_usage: true } }) }),
    })
  }

  function resultOf(
    status: number,
    text: string,
    toolCalls: ChatToolCall[],
    finish: unknown,
    usage: { inputTokens: number; outputTokens: number },
    reported: unknown,
  ): ChatResult {
    if (text === '' && toolCalls.length === 0) throw unreadable(PROVIDER, status, 'with no text')
    return {
      text,
      stopReason: stopReasonOf(finish),
      usage,
      model: typeof reported === 'string' && reported !== '' ? reported : config.model,
      toolCalls,
    }
  }

  async function* streamed(
    status: number,
    body: ReadableStream<Uint8Array>,
    life: Lifetime,
  ): AsyncGenerator<ChatStreamEvent> {
    const events = sseEvents(body)
    let reported: unknown
    let inputTokens = 0
    let outputTokens = 0
    let finish: unknown
    let text = ''
    const toolCalls: ChatToolCall[] = []
    // A call's pieces by its index, until the finish reason says every call is complete.
    const building = new Map<number, { id: unknown; name: unknown; json: string }>()
    try {
      for (;;) {
        let next: IteratorResult<SseEvent>
        try {
          next = await events.next()
        } catch {
          throw life.ended() ?? brokenOff(PROVIDER)
        }
        if (next.done === true || next.value.data === '[DONE]') break
        const chunk = jsonOf(next.value.data)
        if (!isRecord(chunk)) throw unreadable(PROVIDER, status, 'with a chunk that is not JSON')
        if (chunk['error'] !== undefined) throw brokenOff(PROVIDER)
        if (chunk['model'] !== undefined) reported = chunk['model']
        if (isRecord(chunk['usage'])) {
          inputTokens = count(chunk['usage']['prompt_tokens'])
          outputTokens = count(chunk['usage']['completion_tokens'])
        }
        const choice = recOf(Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined)
        const delta = recOf(choice['delta'])
        const content = delta['content']
        if (typeof content === 'string' && content !== '') {
          text += content
          yield { type: 'text', delta: content }
        }
        if (Array.isArray(delta['tool_calls'])) {
          for (const piece of (delta['tool_calls'] as unknown[]).map(recOf)) {
            const index = typeof piece['index'] === 'number' ? piece['index'] : 0
            const fn = recOf(piece['function'])
            const call = building.get(index) ?? { id: undefined, name: undefined, json: '' }
            if (piece['id'] !== undefined) call.id = piece['id']
            if (fn['name'] !== undefined) call.name = fn['name']
            if (typeof fn['arguments'] === 'string') call.json += fn['arguments']
            building.set(index, call)
          }
        }
        if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) {
          finish = choice['finish_reason']
          for (const index of [...building.keys()].sort((a, b) => a - b)) {
            const built = building.get(index)!
            const call = wireCallOf(built.id, built.name, built.json)
            if (call === undefined) {
              throw unreadable(
                PROVIDER,
                status,
                'with a tool call whose arguments are not an object',
              )
            }
            toolCalls.push(call)
            yield { type: 'tool_call', call }
          }
          building.clear()
        }
      }
      // Ended with no finish reason: the answer is not complete.
      if (finish === undefined) throw life.ended() ?? brokenOff(PROVIDER)
      yield {
        type: 'done',
        result: resultOf(status, text, toolCalls, finish, { inputTokens, outputTokens }, reported),
      }
    } finally {
      await events.return(undefined)
    }
  }

  const adapter: AiAdapter = {
    kind: 'ai',
    providerName: PROVIDER,
    endpoint: base,
    capabilities: () => ['complete', 'chat', 'tools', 'stream'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {
      // no-op: each chat() is one request
    },
    async healthCheck() {
      return { status: 'healthy', detail: `OpenAI AI adapter using model ${config.model}` }
    },

    async embed() {
      throw new AdapterError('not_configured', 'Embedding not yet supported by the OpenAI adapter')
    },

    async complete(prompt, opts) {
      const maxTokens = opts?.maxTokens
      const result = await adapter.chat(
        [{ role: 'user', content: prompt }],
        maxTokens === undefined ? {} : { maxTokens },
      )
      return result.text
    },

    async chat(messages, opts): Promise<ChatResult> {
      const request = requestOf(messages, opts, false)
      const life = lifetime(PROVIDER, timeoutMs, opts?.signal)
      let status: number
      let text: string
      try {
        const response = await post(PROVIDER, url, headers, request, life)
        status = response.status
        text = await bodyText(PROVIDER, response, life)
      } finally {
        life.close()
      }
      const body = jsonOf(text)
      if (!isRecord(body)) throw unreadable(PROVIDER, status, 'with a body that is not JSON')
      const choice = recOf(Array.isArray(body['choices']) ? body['choices'][0] : undefined)
      const message = recOf(choice['message'])
      const toolCalls: ChatToolCall[] = []
      const wireCalls = Array.isArray(message['tool_calls'])
        ? (message['tool_calls'] as unknown[])
        : []
      for (const wire of wireCalls.map(recOf)) {
        const fn = recOf(wire['function'])
        const call = wireCallOf(wire['id'], fn['name'], fn['arguments'])
        if (call === undefined) {
          throw unreadable(PROVIDER, status, 'with a tool call whose arguments are not an object')
        }
        toolCalls.push(call)
      }
      const usage = recOf(body['usage'])
      return resultOf(
        status,
        typeof message['content'] === 'string' ? message['content'] : '',
        toolCalls,
        choice['finish_reason'],
        {
          inputTokens: count(usage['prompt_tokens']),
          outputTokens: count(usage['completion_tokens']),
        },
        body['model'],
      )
    },

    async *chatStream(messages, opts) {
      const request = requestOf(messages, opts, true)
      const life = lifetime(PROVIDER, timeoutMs, opts?.signal)
      try {
        const response = await post(PROVIDER, url, headers, request, life)
        if (response.body === null) throw unreadable(PROVIDER, response.status, 'with no body')
        yield* streamed(response.status, response.body, life)
      } finally {
        life.close()
      }
    },
  }
  return adapter
}
