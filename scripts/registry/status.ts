/** A failing streak this old is suspended. Measured on the clock, so missed nights count. */
export const SUSPEND_AFTER_MS = 7 * 24 * 3600 * 1000

/** One night's certification of one adapter. An install failure or a `CertifyError` is a `fail` carrying its line. */
export type RunResult =
  | { kind: 'pass'; passed: number }
  | { kind: 'fail'; line: string }
  | { kind: 'no-suite'; line: string }

export type EntryStatus = 'passing' | 'failing' | 'suspended' | 'no-suite' | 'first-party'

/** What the registry carries from night to night for one package. Times are ISO strings. */
export interface EntryHistory {
  status: EntryStatus
  /** The first failure of the current failing streak; null when the last night did not fail. */
  failingSince: string | null
  lastRun: string
  line: string
}

export function nextStatus(
  prev: EntryHistory | undefined,
  result: RunResult,
  at: Date,
): EntryHistory {
  const lastRun = at.toISOString()
  if (result.kind === 'pass') {
    return { status: 'passing', failingSince: null, lastRun, line: `${result.passed} cases passed` }
  }
  if (result.kind === 'no-suite') {
    return { status: 'no-suite', failingSince: null, lastRun, line: result.line }
  }
  const failingSince = prev?.failingSince ?? lastRun
  const suspended = at.getTime() - Date.parse(failingSince) >= SUSPEND_AFTER_MS
  return { status: suspended ? 'suspended' : 'failing', failingSince, lastRun, line: result.line }
}
