import type { AdapterBase, HealthReport } from '@nymbal/types'

export function noopInitialize(_config: unknown): Promise<void> {
  return Promise.resolve()
}

export function okHealth(detail?: string): Promise<HealthReport> {
  const report: HealthReport = { status: 'healthy', ...(detail !== undefined && { detail }) }
  return Promise.resolve(report)
}

export function buildBaseFields(
  capabilities: readonly string[],
  producesEvents: readonly string[],
  consumesEvents: readonly string[],
): Omit<AdapterBase, 'initialize' | 'healthCheck'> {
  return { capabilities, producesEvents, consumesEvents }
}
