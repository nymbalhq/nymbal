import { AdapterError, type CommerceSlot, type HealthReport } from '@nymbalhq/types'

/**
 * The adapter a slot resolves to when a secret its provider package declares is set nowhere (config, environment or
 * Settings): the store boots, so the admin can take the key, while the slot reports itself down and refuses every
 * operation. For payments the storefront gets the provider's driver with no publishable key, so it cannot mount and
 * Place Order stays disabled.
 */
export function createNotConfiguredAdapter(
  slot: CommerceSlot,
  provider: string,
  missing: readonly string[],
): unknown {
  const fields = missing.map((path) => `${slot}.${path}`).join(', ')
  const detail = `${provider} is not configured: ${fields} not set (in the config, the environment or the admin's Settings)`
  const base: Record<PropertyKey, unknown> = {
    kind: slot,
    providerName: provider,
    capabilities: () => [],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    async healthCheck(): Promise<HealthReport> {
      return { status: 'down', detail }
    },
    ...(slot === 'payments' && { client: () => ({ driver: provider, options: {} }) }),
  }
  const refuse = async (): Promise<never> => {
    throw new AdapterError('not_configured', detail, { context: { slot, provider, missing } })
  }
  return new Proxy(base, {
    get(target, property, receiver) {
      // `then` would make the adapter a thenable that every `await` of it calls; `toJSON` would serialise a promise.
      if (
        typeof property === 'symbol' ||
        property in target ||
        property === 'then' ||
        property === 'toJSON'
      ) {
        return Reflect.get(target, property, receiver)
      }
      return refuse
    },
  })
}
