import Anthropic from '@anthropic-ai/sdk'
import type { AiAdapter, Logger } from '@nymbal/types'
import { AdapterError } from '@nymbal/types'
import { noopInitialize, okHealth } from '../base.js'

export interface AnthropicAiAdapterConfig {
  apiKey: string
  model?: string
  logger: Logger
}

export function createAnthropicAiAdapter(config: AnthropicAiAdapterConfig): AiAdapter {
  const model = config.model ?? 'claude-sonnet-4-6'
  const client = new Anthropic({ apiKey: config.apiKey })

  return {
    kind: 'ai',
    providerName: 'anthropic',
    capabilities: ['complete'],
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth(`Anthropic AI adapter using model ${model}`),

    async embed() {
      throw new AdapterError('not_configured', 'Embedding not yet supported by the Anthropic adapter')
    },

    async complete(prompt, opts) {
      const maxTokens = opts?.maxTokens ?? 1024
      const message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      })
      const block = message.content[0]
      if (!block || block.type !== 'text') {
        throw new AdapterError('unexpected_response', 'Anthropic returned no text content')
      }
      return block.text
    },
  }
}
