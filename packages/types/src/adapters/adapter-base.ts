import type { Logger } from './http.js'

export type HealthStatus = 'healthy' | 'degraded' | 'down'

export interface HealthReport {
  status: HealthStatus
  detail?: string
}

export interface AdapterBase {
  /** What this adapter offers, for the app's per-slot report; each adapter answers for itself. */
  capabilities(): readonly string[]
  readonly producesEvents: readonly string[]
  readonly consumesEvents: readonly string[]
  initialize(config: unknown): Promise<void>
  healthCheck(): Promise<HealthReport>
}

/** The commerce slots a store's config names a provider for. */
export type CommerceSlot =
  | 'payments'
  | 'email'
  | 'reviews'
  | 'search'
  | 'analytics'
  | 'shipping'
  | 'tax'
  | 'ai'

/** Every slot an adapter package can fill: the commerce slots and the infrastructure primitives. */
export type Slot = CommerceSlot | 'documentStore' | 'eventBus' | 'media'

/**
 * What the kernel hands an adapter package's `createAdapter`. A package that serves more than one slot switches on
 * `slot`; `config` is a commerce slot's `config` block from nymbal.config.ts, or a primitive's connection block.
 */
export interface AdapterContext {
  slot: Slot
  config: Record<string, unknown>
  logger: Logger
  env: NodeJS.ProcessEnv
}
