import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReporterDescription } from '@playwright/test'

const REPORTS = fileURLToPath(new URL('../../../reports/', import.meta.url))

/**
 * The reporters an E2E run uses. Under CI (the gate's E2E steps set it, one invocation per target) the GitHub
 * annotations plus a JSON report per target at `reports/e2e-<target>.json` in the repository root: a test that
 * passed only on a retry is `flaky` there, and only there, since retries hide it from the exit status. By hand, `list`.
 */
export function e2eReporters(
  ci: boolean,
  target: string | undefined,
  dir: string = REPORTS,
): ReporterDescription[] | 'list' {
  return ci
    ? [['github'], ['json', { outputFile: join(dir, `e2e-${target ?? 'all'}.json`) }]]
    : 'list'
}
