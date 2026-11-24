import type { ReadTx } from '../db/command-store.js'
import { localDayOf } from '../reports/time.js'
import type { InsightDraft, NightShiftContext, NightShiftDeps } from './jobs.js'

/** One fault in the store's own machinery: a draft when it holds tonight, else null. */
export interface OperatorCheck {
  subject: string
  find(tx: ReadTx, deps: NightShiftDeps, ctx: NightShiftContext): Promise<InsightDraft | null>
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** A run still `running` this long after it started is taken to have died. */
const STALE_RUN_MS = HOUR_MS
/** The data day begins less than three days before any instant of the run day, in any zone. */
const DATA_DAY_READ_MS = 3 * DAY_MS
const OPERATOR_HEALTH = 'operator-health'

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

const deadEvents: OperatorCheck = {
  subject: 'events.dead',
  async find(tx, deps) {
    const dead = await deps.repos.eventLog.countDead(tx)
    if (dead === 0) return null
    return {
      subject: 'events.dead',
      severity: 'warning',
      summary: `${dead} ${plural(dead, 'event', 'events')} could not be delivered and ${plural(dead, 'was', 'were')} set aside; retry or look into ${plural(dead, 'it', 'them')}.`,
      facts: { deadEvents: dead },
    }
  },
}

const outcomeUnknown: OperatorCheck = {
  subject: 'proposals.outcome-unknown',
  async find(tx, deps, ctx) {
    const since = new Date(ctx.now.getTime() - DATA_DAY_READ_MS)
    const settled = await deps.repos.proposal.outcomeUnknownSettledSince(tx, since)
    const proposals = settled.filter(
      (at) => localDayOf(new Date(at), ctx.timeZone) === ctx.dataDay,
    ).length
    if (proposals === 0) return null
    return {
      subject: 'proposals.outcome-unknown',
      severity: 'warning',
      summary: `${proposals} approved ${plural(proposals, 'proposal', 'proposals')} stopped while running yesterday, so whether ${plural(proposals, 'it', 'they')} went through is unknown; check the records ${plural(proposals, 'it', 'they')} touched.`,
      facts: { proposals },
    }
  },
}

const failedRuns: OperatorCheck = {
  subject: 'night-shift.failed',
  async find(tx, deps, ctx) {
    const staleBefore = new Date(ctx.now.getTime() - STALE_RUN_MS)
    const problems = (
      await deps.repos.insight.problemRuns(tx, [ctx.dataDay, ctx.runDay], staleBefore)
    ).filter((run) => run.job !== OPERATOR_HEALTH)
    if (problems.length === 0) return null
    const runs = problems.length
    const failedJobs = [...new Set(problems.map((run) => run.job))].sort().join(', ')
    return {
      subject: 'night-shift.failed',
      severity: 'warning',
      summary: `${runs} night-shift ${plural(runs, 'run', 'runs')} failed or did not finish: ${failedJobs}.`,
      facts: { failedJobs, runs },
    }
  },
}

/** The operator checks, in the order their insights are written. */
export const OPERATOR_CHECKS: OperatorCheck[] = [deadEvents, outcomeUnknown, failedRuns]
