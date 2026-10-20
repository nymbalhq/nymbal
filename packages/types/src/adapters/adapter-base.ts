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

/**
 * What the kernel hands an adapter package's `createAdapter`. A package that serves more than one slot switches on
 * `slot`; `config` is the slot's `config` block from nymbal.config.ts.
 */
export interface AdapterContext {
  slot: CommerceSlot
  config: Record<string, unknown>
  logger: Logger
  env: NodeJS.ProcessEnv
}
