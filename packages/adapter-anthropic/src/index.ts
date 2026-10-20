import { ConfigError, type AdapterContext, type AiAdapter } from '@nymbalhq/types'
import { createAnthropicAiAdapter, type AnthropicAiAdapterConfig } from './anthropic-adapter.js'

export { createAnthropicAiAdapter, type AnthropicAiAdapterConfig }

/** The kernel's entry: `ai: { provider: 'anthropic', config: { apiKey?, model? } }`, the key falling back to ANTHROPIC_API_KEY. */
export function createAdapter(ctx: AdapterContext): AiAdapter {
  if (ctx.slot !== 'ai') {
    throw new ConfigError(`@nymbalhq/adapter-anthropic serves ai, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  const apiKey = ctx.config['apiKey']
  const model = ctx.config['model']
  return createAnthropicAiAdapter({
    apiKey:
      typeof apiKey === 'string' && apiKey !== '' ? apiKey : (ctx.env['ANTHROPIC_API_KEY'] ?? ''),
    ...(typeof model === 'string' && { model }),
    logger: ctx.logger,
  })
}
