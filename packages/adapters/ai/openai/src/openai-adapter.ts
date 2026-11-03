import type { AiAdapter, ChatResult, ChatStopReason, Logger } from '@nymbalhq/types'
import { AdapterError } from '@nymbalhq/types'
import {
  answered,
  bounded,
  checkChat,
  DEFAULT_TIMEOUT_MS,
  jsonOf,
  unreachable,
  unreadable,
} from './chat.js'

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export interface OpenAiAdapterConfig {
  apiKey: string
  /** The model the server serves, sent with every request. */
  model: string
  /** Where the chat completions API is, its path prefix included; OpenAI's own when omitted. */
  baseUrl?: string
  /** How long one chat() waits for its answer; 60 000 when omitted. */
  timeoutMs?: number
  logger: Logger
}

const PROVIDER = 'openai'

function stopReasonOf(wire: unknown): ChatStopReason {
  if (wire === 'stop') return 'end'
  if (wire === 'length') return 'max_tokens'
  return 'other'
}

const count = (value: unknown): number => (typeof value === 'number' ? value : 0)

interface CompletionBody {
  model?: unknown
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
}

export function createOpenAiAdapter(config: OpenAiAdapterConfig): AiAdapter {
  const base = config.baseUrl ?? DEFAULT_BASE_URL
  const url = `${base.endsWith('/') ? base.slice(0, -1) : base}/chat/completions`
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const adapter: AiAdapter = {
    kind: 'ai',
    providerName: PROVIDER,
    capabilities: () => ['complete', 'chat'],
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
      const maxTokens = checkChat(PROVIDER, messages, opts)
      const system = opts?.system
      const request = JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        messages: [
          ...(system !== undefined && system !== '' ? [{ role: 'system', content: system }] : []),
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      })
      const { status, text } = await bounded(PROVIDER, timeoutMs, async (signal) => {
        try {
          const response = await globalThis.fetch(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              'content-type': 'application/json',
            },
            body: request,
            signal,
          })
          return { status: response.status, text: await response.text() }
        } catch {
          // fetch's own error may quote the request's headers, the key among them: none of it goes on.
          throw unreachable(PROVIDER)
        }
      })
      const body = jsonOf(text) as CompletionBody | null | undefined
      if (status < 200 || status > 299) {
        const error = (body as { error?: { message?: unknown } } | null | undefined)?.error
        throw answered(PROVIDER, status, error?.message, config.apiKey)
      }
      if (typeof body !== 'object' || body === null) {
        throw unreadable(PROVIDER, status, 'with a body that is not JSON')
      }
      const choice = Array.isArray(body.choices) ? body.choices[0] : undefined
      const answer = choice?.message?.content
      if (typeof answer !== 'string' || answer === '') {
        throw unreadable(PROVIDER, status, 'with no text')
      }
      return {
        text: answer,
        stopReason: stopReasonOf(choice?.finish_reason),
        usage: {
          inputTokens: count(body.usage?.prompt_tokens),
          outputTokens: count(body.usage?.completion_tokens),
        },
        model: typeof body.model === 'string' && body.model !== '' ? body.model : config.model,
      }
    },
  }
  return adapter
}
