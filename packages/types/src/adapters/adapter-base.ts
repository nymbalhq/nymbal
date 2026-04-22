export type HealthStatus = 'healthy' | 'degraded' | 'down'

export interface HealthReport {
  status: HealthStatus
  detail?: string
}

export interface AdapterBase {
  readonly capabilities: readonly string[]
  readonly producesEvents: readonly string[]
  readonly consumesEvents: readonly string[]
  initialize(config: unknown): Promise<void>
  healthCheck(): Promise<HealthReport>
}
