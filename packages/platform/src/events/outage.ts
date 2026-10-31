import { boundedHealthCheck, HEALTH_CHECK_TIMEOUT_MS, type HealthReport } from '@nymbalhq/types'
import { isNotConfigured } from '../adapters/not-configured.js'

/** A primitive or slot adapter the relay may depend on: `name` is the slot or primitive, the provider is in the detail. */
export interface OutageSubject {
  name: string
  healthCheck?(): Promise<HealthReport>
}

export interface OutageReport {
  /** True when any checked subject is down, threw or did not answer in time. */
  outage: boolean
  down: readonly { name: string; detail: string }[]
}

export interface OutageProbeOptions {
  /** The bound on each subject's health check (default `HEALTH_CHECK_TIMEOUT_MS`). */
  timeoutMs?: number
}

/**
 * Checks every subject in parallel. `degraded` and a subject with no health check are not an outage, and a
 * not-configured placeholder is skipped: it answers `down` for ever, so counting it would keep every failure from
 * counting and a poison event from ever dying.
 */
export function createOutageProbe(
  subjects: readonly OutageSubject[],
  options: OutageProbeOptions = {},
): () => Promise<OutageReport> {
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const checked = subjects.filter(
    (subject) => !isNotConfigured(subject) && typeof subject.healthCheck === 'function',
  )
  return async () => {
    const reports = await Promise.all(
      checked.map(async (subject) => ({
        name: subject.name,
        report: await boundedHealthCheck(() => subject.healthCheck!(), { timeoutMs }),
      })),
    )
    const down = reports
      .filter(({ report }) => report.status === 'down')
      .map(({ name, report }) => ({ name, detail: report.detail ?? 'down' }))
    return { outage: down.length > 0, down }
  }
}
