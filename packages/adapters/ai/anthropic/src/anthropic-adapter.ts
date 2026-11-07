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
  secretsOf,
  unreadable,
  type Lifetime,
} from './chat.js'
import { sseEvents, type SseEvent } from './sse.js'

export const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'

export interface AnthropicAiAdapterConfig {
  apiKey: string
  model?: string
  /** Where the Messages API is; Anthropic's own when omitted (a stand-in for tests). */
  baseUrl?: string
  /** How long one chat() waits for its answer, or one chatStream() for its end; 60 000 when omitted. */
  timeoutMs?: number
  logger: Logger
}

const PROVIDER = 'anthropic'

function stopReasonOf(wire: unknown): ChatStopReason {
  if (wire === 'end_turn' || wire === 'stop_sequence') return 'end'
  if (wire === 'max_tokens') return 'max_tokens'
  if (wire === 'tool_use') return 'tool_use'
  return 'other'
}

const count = (value: unknown): number => (typeof value === 'number' ? value : 0)

/** The conversation as Anthropic's turns: calls as `tool_use` blocks, each run of tool turns as one user turn. */
function wireMessages(messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = []
  let results: unknown[] | undefined
  for (const m of messages) {
    if (m.role === 'tool') {
      const result = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError === true && { is_error: true }),
      }
      if (results === undefined) {
        results = [result]
        out.push({ role: 'user', content: results })
      } else results.push(result)
      continue
    }
    results = undefined
    const calls = m.role === 'assistant' ? (m.toolCalls ?? []) : []
    out.push(
      calls.length === 0
        ? { role: m.role, content: m.content }
        : {
            role: m.role,
            content: [
              ...(m.content === '' ? [] : [{ type: 'text', text: m.content }]),
              ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
            ],
          },
    )
  }
  return out
}

export function createAnthropicAiAdapter(config: AnthropicAiAdapterConfig): AiAdapter {
  const model = config.model ?? 'claude-sonnet-4-6'
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const base = config.baseUrl ?? DEFAULT_BASE_URL
  const url = `${base.endsWith('/') ? base.slice(0, -1) : base}/v1/messages`
  const headers = { 'x-api-key': config.apiKey, 'anthropic-version': API_VERSION }

  function requestOf(
    messages: readonly ChatMessage[],
    opts: ChatOptions | undefined,
    stream: boolean,
  ): string {
    const maxTokens = checkChat(PROVIDER, messages, opts)
    const system = opts?.system
    const tools = opts?.tools ?? []
    return JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: wireMessages(messages),
      ...(system !== undefined && system !== '' && { system }),
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      }),
      ...(stream && { stream: true }),
    })
  }

  function resultOf(
    status: number,
    text: string,
    toolCalls: ChatToolCall[],
    stop: unknown,
    usage: { inputTokens: number; outputTokens: number },
    reported: unknown,
  ): ChatResult {
    if (text === '' && toolCalls.length === 0) throw unreadable(PROVIDER, status, 'with no text')
    return {
      text,
      stopReason: stopReasonOf(stop),
      usage,
      model: typeof reported === 'string' && reported !== '' ? reported : model,
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
    let stop: unknown
    let text = ''
    const toolCalls: ChatToolCall[] = []
    const building = new Map<unknown, { id: unknown; name: unknown; json: string }>()
    try {
      for (;;) {
        let next: IteratorResult<SseEvent>
        try {
          next = await events.next()
        } catch {
          throw life.ended() ?? brokenOff(PROVIDER)
        }
        // Ended before message_stop: the answer is not complete.
        if (next.done === true) throw life.ended() ?? brokenOff(PROVIDER)
        if (next.value.event === 'error') throw brokenOff(PROVIDER)
        const e = jsonOf(next.value.data)
        if (!isRecord(e)) throw unreadable(PROVIDER, status, 'with an event that is not JSON')
        if (e['type'] === 'message_start') {
          const message = recOf(e['message'])
          reported = message['model']
          inputTokens = count(recOf(message['usage'])['input_tokens'])
        } else if (e['type'] === 'content_block_start') {
          const block = recOf(e['content_block'])
          if (block['type'] === 'tool_use') {
            building.set(e['index'], { id: block['id'], name: block['name'], json: '' })
          }
        } else if (e['type'] === 'content_block_delta') {
          const delta = recOf(e['delta'])
          const piece = delta['partial_json']
          if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            if (delta['text'] !== '') {
              text += delta['text']
              yield { type: 'text', delta: delta['text'] }
            }
          } else if (delta['type'] === 'input_json_delta' && typeof piece === 'string') {
            const call = building.get(e['index'])
            if (call !== undefined) call.json += piece
          }
        } else if (e['type'] === 'content_block_stop') {
          const built = building.get(e['index'])
          if (built !== undefined) {
            building.delete(e['index'])
            const call = callOf(built.id, built.name, built.json === '' ? {} : jsonOf(built.json))
            if (call === undefined) {
              throw unreadable(PROVIDER, status, 'with a tool call whose input is not an object')
            }
            toolCalls.push(call)
            yield { type: 'tool_call', call }
          }
        } else if (e['type'] === 'message_delta') {
          stop = recOf(e['delta'])['stop_reason']
          const out = recOf(e['usage'])['output_tokens']
          if (typeof out === 'number') outputTokens = out
        } else if (e['type'] === 'message_stop') {
          yield {
            type: 'done',
            result: resultOf(
              status,
              text,
              toolCalls,
              stop,
              { inputTokens, outputTokens },
              reported,
            ),
          }
          return
        }
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
      return { status: 'healthy', detail: `Anthropic AI adapter using model ${model}` }
    },

    async embed() {
      throw new AdapterError(
        'not_configured',
        'Embedding not yet supported by the Anthropic adapter',
      )
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
        const response = await post(
          PROVIDER,
          url,
          headers,
          request,
          life,
          secretsOf(config.apiKey, messages, opts),
        )
        status = response.status
        text = await bodyText(PROVIDER, response, life)
      } finally {
        life.close()
      }
      const body = jsonOf(text)
      if (!isRecord(body)) throw unreadable(PROVIDER, status, 'with a body that is not JSON')
      const blocks = Array.isArray(body['content']) ? (body['content'] as unknown[]).map(recOf) : []
      const toolCalls: ChatToolCall[] = []
      for (const block of blocks.filter((b) => b['type'] === 'tool_use')) {
        const call = callOf(block['id'], block['name'], block['input'])
        if (call === undefined) {
          throw unreadable(PROVIDER, status, 'with a tool call whose input is not an object')
        }
        toolCalls.push(call)
      }
      const answer = blocks
        .map((b) => (b['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : ''))
        .join('')
      const usage = recOf(body['usage'])
      return resultOf(
        status,
        answer,
        toolCalls,
        body['stop_reason'],
        {
          inputTokens: count(usage['input_tokens']),
          outputTokens: count(usage['output_tokens']),
        },
        body['model'],
      )
    },

    async *chatStream(messages, opts) {
      const request = requestOf(messages, opts, true)
      const life = lifetime(PROVIDER, timeoutMs, opts?.signal)
      try {
        const response = await post(
          PROVIDER,
          url,
          headers,
          request,
          life,
          secretsOf(config.apiKey, messages, opts),
        )
        if (response.body === null) throw unreadable(PROVIDER, response.status, 'with no body')
        yield* streamed(response.status, response.body, life)
      } finally {
        life.close()
      }
    },
  }
  return adapter
}
