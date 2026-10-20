import type { AdapterContext, Logger } from '@nymbalhq/types'

// The AdapterContext the P2-02 store and bus packages are built from in their own tests (decision 2: `slot` widens to
// the infrastructure slots, and `config` carries the slot's connection block). A silent logger: the packages may not
// import the kernel's.

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

export function adapterContext(
  slot: 'documentStore' | 'eventBus',
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): AdapterContext {
  // Through unknown until AdapterContext.slot is the widened Slot; afterwards the object is an AdapterContext as it is.
  return { slot, config, logger: silent, env } as unknown as AdapterContext
}
