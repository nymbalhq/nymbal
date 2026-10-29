import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type AiAdapter,
} from '@nymbalhq/types'
import { createAnthropicAiAdapter, type AnthropicAiAdapterConfig } from './anthropic-adapter.js'

export { createAnthropicAiAdapter, type AnthropicAiAdapterConfig }

/** The fields the admin's Settings may fill when the config (and, for the key, ANTHROPIC_API_KEY) leaves them unset. */
export const settings: AdapterSetting[] = [
  { path: 'apiKey', label: 'API key', secret: true, env: 'ANTHROPIC_API_KEY' },
  { path: 'baseUrl', label: 'API base URL', secret: false },
]

/**
 * The kernel's entry: `ai: { provider: 'anthropic', config: { apiKey?, model?, baseUrl? } }`, the key falling back to
 * ANTHROPIC_API_KEY.
 */
export function createAdapter(ctx: AdapterContext): AiAdapter {
  if (ctx.slot !== 'ai') {
    throw new ConfigError(`@nymbalhq/ai-anthropic serves ai, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  const apiKey = ctx.config['apiKey']
  const model = ctx.config['model']
  const baseUrl = ctx.config['baseUrl']
  return createAnthropicAiAdapter({
    apiKey:
      typeof apiKey === 'string' && apiKey !== '' ? apiKey : (ctx.env['ANTHROPIC_API_KEY'] ?? ''),
    ...(typeof model === 'string' && { model }),
    ...(typeof baseUrl === 'string' && baseUrl !== '' && { baseUrl }),
    logger: ctx.logger,
  })
}
