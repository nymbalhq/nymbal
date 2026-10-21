import type { AdapterContext, Logger, Slot } from '@nymbalhq/types'

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

/**
 * The AdapterContext the kernel hands a package's `createAdapter`, with a silent logger: `config` is a commerce slot's
 * `config` record or a primitive's connection block.
 */
export function adapterContext(
  slot: Slot,
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): AdapterContext {
  return { slot, config, logger: silent, env }
}
