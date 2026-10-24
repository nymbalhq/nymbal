import type { HealthReport } from '@nymbalhq/types'

export function noopInitialize(_config: unknown): Promise<void> {
  return Promise.resolve()
}

export function okHealth(detail?: string): Promise<HealthReport> {
  const report: HealthReport = { status: 'healthy', ...(detail !== undefined && { detail }) }
  return Promise.resolve(report)
}
