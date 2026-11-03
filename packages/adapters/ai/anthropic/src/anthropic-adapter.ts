import Anthropic, { APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'
import type { AiAdapter, ChatResult, ChatStopReason, Logger } from '@nymbalhq/types'
import { AdapterError } from '@nymbalhq/types'
import {
  answered,
  bounded,
  checkChat,
  DEFAULT_TIMEOUT_MS,
  jsonOf,
  timedOut,
  unreachable,
  unreadable,
} from './chat.js'

export interface AnthropicAiAdapterConfig {
  apiKey: string
  model?: string
  /** Where the Messages API is; Anthropic's own when omitted (a stand-in for tests). */
  baseUrl?: string
  /** How long one chat() waits for its answer; 60 000 when omitted. */
  timeoutMs?: number
  logger: Logger
}

const PROVIDER = 'anthropic'

function stopReasonOf(wire: unknown): ChatStopReason {
  if (wire === 'end_turn' || wire === 'stop_sequence') return 'end'
  if (wire === 'max_tokens') return 'max_tokens'
  return 'other'
}

const count = (value: unknown): number => (typeof value === 'number' ? value : 0)

interface MessageBody {
  model?: unknown
  content?: unknown
  stop_reason?: unknown
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
}

export function createAnthropicAiAdapter(config: AnthropicAiAdapterConfig): AiAdapter {
  const model = config.model ?? 'claude-sonnet-4-6'
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // One attempt: the caller decides on a retry, and chat() stays bounded by timeoutMs.
  const client = new Anthropic({
    apiKey: config.apiKey,
    maxRetries: 0,
    timeout: timeoutMs,
    ...(config.baseUrl !== undefined && { baseURL: config.baseUrl }),
  })

  const adapter: AiAdapter = {
    kind: 'ai',
    providerName: PROVIDER,
    capabilities: () => ['complete', 'chat'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {
      // no-op: the client is constructed above
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
      const maxTokens = checkChat(PROVIDER, messages, opts)
      const system = opts?.system
      const { status, text } = await bounded(PROVIDER, timeoutMs, async (signal) => {
        try {
          const response = await client.messages
            .create(
              {
                model,
                max_tokens: maxTokens,
                messages: messages.map((m) => ({ role: m.role, content: m.content })),
                ...(system !== undefined && system !== '' && { system }),
              },
              { signal },
            )
            .asResponse()
          return { status: response.status, text: await response.text() }
        } catch (error) {
          // The SDK's error keeps the response's headers and body, which may echo the key: only the status goes on.
          if (error instanceof APIConnectionTimeoutError) throw timedOut(PROVIDER, timeoutMs)
          if (error instanceof APIError && typeof error.status === 'number') {
            const body = error.error as { error?: { message?: unknown } } | undefined
            throw answered(PROVIDER, error.status, body?.error?.message, config.apiKey)
          }
          throw unreachable(PROVIDER)
        }
      })
      const body = jsonOf(text) as MessageBody | null | undefined
      if (typeof body !== 'object' || body === null) {
        throw unreadable(PROVIDER, status, 'with a body that is not JSON')
      }
      const answer = (Array.isArray(body.content) ? (body.content as unknown[]) : [])
        .map((block) => {
          const b = block as { type?: unknown; text?: unknown } | null
          return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''
        })
        .join('')
      if (answer === '') throw unreadable(PROVIDER, status, 'with no text')
      return {
        text: answer,
        stopReason: stopReasonOf(body.stop_reason),
        usage: {
          inputTokens: count(body.usage?.input_tokens),
          outputTokens: count(body.usage?.output_tokens),
        },
        model: typeof body.model === 'string' && body.model !== '' ? body.model : model,
      }
    },
  }
  return adapter
}
