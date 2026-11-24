import { v7 as uuidv7 } from 'uuid'
import { EVT_INSIGHT_CREATED } from '@nymbalhq/types'
import { runAsActor } from '../audit/actor.js'
import { audit, auditedCommand } from '../audit/audit.js'
import { addDays, localDayOf } from '../reports/time.js'
import type { InsightRecord } from '../repositories/insight.js'
import type { SweeperHandle } from '../sweepers/inventory-reservation-sweeper.js'
import { runGuidance, type GuidanceDeps } from './guidance.js'
import {
  NIGHT_SHIFT_JOBS,
  SUPPRESS_DAYS,
  type InsightDraft,
  type NightShiftContext,
  type NightShiftDeps,
  type NightShiftJob,
} from './jobs.js'

export type { NightShiftDeps } from './jobs.js'

const COMMAND = 'insight.create'
const DAY_MS = 86_400_000

/** What one job did tonight: not claimed (another run holds it), or claimed and `done` or `failed`. */
export interface JobRun {
  job: string
  claimed: boolean
  status?: 'done' | 'failed'
  created: InsightRecord[]
}

const clockFormats = new Map<string, Intl.DateTimeFormat>()

function clockFormat(timeZone: string): Intl.DateTimeFormat {
  let format = clockFormats.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    clockFormats.set(timeZone, format)
  }
  return format
}

/** The store day the night of `now` is for. */
export function runDayOf(now: Date, timeZone: string): string {
  return localDayOf(now, timeZone)
}

/** Whether the store's clock at `now` reads `at` (`HH:MM`) or later. */
export function isDue(now: Date, at: string, timeZone: string): boolean {
  return clockFormat(timeZone).format(now) >= at
}

async function draftsOf(
  job: NightShiftJob,
  deps: NightShiftDeps,
  ctx: NightShiftContext,
): Promise<InsightDraft[]> {
  if ('run' in job) return job.run(deps, ctx)
  const inputs = await deps.store.read((tx) => job.read(tx, deps, ctx))
  return job.detect(inputs, ctx)
}

/** Writes the drafts R2 lets through, up to the job's cap, with their events and the run's `done`, in one transaction. */
function writeDrafts(
  deps: NightShiftDeps,
  job: NightShiftJob,
  ctx: NightShiftContext,
  drafts: InsightDraft[],
): Promise<InsightRecord[]> {
  const { store, repos, publisher } = deps
  const dismissedSince = new Date(ctx.now.getTime() - SUPPRESS_DAYS * DAY_MS)
  return runAsActor({ kind: 'system', id: 'night-shift' }, () =>
    auditedCommand(store, COMMAND, () =>
      store.transaction(async (tx) => {
        const created: InsightRecord[] = []
        for (const draft of drafts) {
          if (job.cap !== undefined && created.length >= job.cap) break
          if (await repos.insight.suppressed(tx, job.id, draft.subject, dismissedSince)) continue
          const row = {
            id: uuidv7(),
            job: job.id,
            subject: draft.subject,
            runDay: ctx.runDay,
            dataDay: ctx.dataDay,
            status: 'open' as const,
            severity: draft.severity,
            summary: draft.summary,
            facts: draft.facts,
            createdAt: ctx.now,
            dismissedAt: null,
          }
          if (!(await repos.insight.insert(tx, row))) continue
          audit.note(COMMAND, [{ type: 'insight', id: row.id }])
          await publisher.publish(EVT_INSIGHT_CREATED, {
            insightId: row.id,
            job: row.job,
            subject: row.subject,
            day: row.runDay,
            dataDay: row.dataDay,
            severity: row.severity,
            summary: row.summary,
            facts: row.facts,
          })
          created.push({
            ...row,
            createdAt: ctx.now.toISOString(),
            dismissedAt: null,
            guidance: null,
            guidanceStatus: null,
          })
        }
        await repos.insight.finishRun(tx, job.id, ctx.runDay, {
          status: 'done',
          at: ctx.now,
          insights: created.length,
          error: null,
        })
        return created
      }),
    ),
  )
}

async function runJob(
  deps: NightShiftDeps,
  job: NightShiftJob,
  ctx: NightShiftContext,
): Promise<JobRun> {
  const { store, repos } = deps
  const claimed = await store.transaction((tx) =>
    repos.insight.claimRun(tx, job.id, ctx.runDay, ctx.now),
  )
  if (!claimed) return { job: job.id, claimed: false, created: [] }
  try {
    const created = await writeDrafts(deps, job, ctx, await draftsOf(job, deps, ctx))
    return { job: job.id, claimed: true, status: 'done', created }
  } catch (err) {
    deps.logger.error({ err, job: job.id, runDay: ctx.runDay }, 'night-shift job failed')
    await store.transaction((tx) =>
      repos.insight.finishRun(tx, job.id, ctx.runDay, {
        status: 'failed',
        at: ctx.now,
        insights: 0,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return { job: job.id, claimed: true, status: 'failed', created: [] }
  }
}

/**
 * The night of `now`, each job claimed for its run day before any work, so a second run or a second replica does
 * nothing a first has done. One job's failure does not stop the next.
 */
export async function runNightShift(deps: NightShiftDeps, now: Date): Promise<JobRun[]> {
  const runDay = runDayOf(now, deps.timeZone)
  const ctx: NightShiftContext = {
    runDay,
    dataDay: addDays(runDay, -1),
    now,
    timeZone: deps.timeZone,
  }
  const runs: JobRun[] = []
  for (const job of deps.jobs ?? NIGHT_SHIFT_JOBS) runs.push(await runJob(deps, job, ctx))
  return runs
}

export interface NightShiftRunnerDeps extends NightShiftDeps {
  /** The store time (`HH:MM`) from which the night is due. */
  at: string
  intervalMs?: number
  now?: () => Date
  /** The guidance pass, run after the night on every due tick, so insights another replica wrote are picked up. */
  guidance?: GuidanceDeps
}

/**
 * Runs the night on an interval once it is due. There is no tick at start: a restart after `at` runs within one
 * interval, and an app built in a test never runs a night it did not ask for.
 */
export function startNightShift(deps: NightShiftRunnerDeps): SweeperHandle {
  const intervalMs = deps.intervalMs ?? 5 * 60_000
  const now = deps.now ?? (() => new Date())
  const logger = deps.logger.child({ sweeper: 'night-shift' })
  let running = false
  const stopped = new AbortController()

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const at = now()
      if (isDue(at, deps.at, deps.timeZone)) {
        await runNightShift(deps, at)
        if (deps.guidance !== undefined) {
          await runGuidance(deps.guidance, runDayOf(at, deps.timeZone), stopped.signal)
        }
      }
    } catch (err) {
      logger.error({ err }, 'night shift failed')
    } finally {
      running = false
    }
  }

  const handle = setInterval(() => void tick(), intervalMs)
  handle.unref()
  return {
    tick,
    stop() {
      clearInterval(handle)
      stopped.abort()
    },
  }
}
