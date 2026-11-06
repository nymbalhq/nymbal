import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type AiAdapter,
} from '@nymbalhq/types'
import { timeoutOf } from './chat.js'
import {
  createOpenAiAdapter,
  DEFAULT_BASE_URL,
  type OpenAiAdapterConfig,
} from './openai-adapter.js'

/** What this package serves: the kernel refuses it on any other slot or provider. */
export const slot = 'ai'
export const provider = 'openai'

export { createOpenAiAdapter, DEFAULT_BASE_URL, type OpenAiAdapterConfig }

/** The fields the admin's Settings may fill when the config (and, for the key, OPENAI_API_KEY) leaves them unset. */
export const settings: AdapterSetting[] = [
  { path: 'apiKey', label: 'API key', secret: true, env: 'OPENAI_API_KEY' },
  { path: 'baseUrl', label: 'API base URL', secret: false },
]

/**
 * The kernel's entry: `ai: { provider: 'openai', config: { model, apiKey?, baseUrl?, tokenField?, timeoutMs? } }`, the
 * key falling back to OPENAI_API_KEY. A `baseUrl` reaches any OpenAI-compatible server (a gateway, Ollama, vLLM);
 * `tokenField` names the length field for one that takes the other.
 */
export function createAdapter(ctx: AdapterContext): AiAdapter {
  if (ctx.slot !== 'ai') {
    throw new ConfigError(`@nymbalhq/ai-openai serves ai, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  const apiKey = ctx.config['apiKey']
  const model = ctx.config['model']
  const baseUrl = ctx.config['baseUrl']
  if (typeof model !== 'string' || model === '') {
    throw new ConfigError(
      'commerce.ai.config.model is not set: name the model the provider serves',
      { context: { slot: ctx.slot } },
    )
  }
  const tokenField = ctx.config['tokenField']
  if (
    tokenField !== undefined &&
    tokenField !== 'max_tokens' &&
    tokenField !== 'max_completion_tokens'
  ) {
    throw new ConfigError(
      "commerce.ai.config.tokenField is neither 'max_tokens' nor 'max_completion_tokens'",
      { context: { slot: ctx.slot } },
    )
  }
  return createOpenAiAdapter({
    apiKey:
      typeof apiKey === 'string' && apiKey !== '' ? apiKey : (ctx.env['OPENAI_API_KEY'] ?? ''),
    model,
    ...(typeof baseUrl === 'string' && baseUrl !== '' && { baseUrl }),
    ...(tokenField !== undefined && { tokenField }),
    timeoutMs: timeoutOf(ctx.config['timeoutMs']),
    logger: ctx.logger,
  })
}
