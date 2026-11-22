import {
  EVT_INSIGHT_DISMISSED,
  NymbalError,
  type InsightList,
  type InsightSeverity,
  type InsightView,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore } from '../db/command-store.js'
import type { EventPublisher } from '../events/publisher.js'
import type { InsightRecord, InsightRepository } from '../repositories/insight.js'

export interface InsightServiceDeps {
  store: CommandStore
  insights: InsightRepository
  publisher: EventPublisher
  /** The clock a dismiss is stamped with: the night shift's, so the 7 quiet days count on the clock its nights read. */
  now?: () => Date
}

export interface InsightService {
  /** Every open insight, the most serious first, then the newest night, then job and subject. */
  list(): Promise<InsightList>
  /** Dismisses an open insight as the request's actor; answers the dismissed row. */
  dismiss(id: string): Promise<InsightView>
}

export class InsightError extends NymbalError {
  readonly status: 404 | 409

  constructor(code: 'insight.not_found' | 'insight.dismissed', id: string) {
    super(
      code,
      code === 'insight.not_found' ? `No insight ${id}` : `Insight ${id} is already dismissed`,
      { context: { id } },
    )
    this.status = code === 'insight.not_found' ? 404 : 409
  }
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 }

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function briefOrder(a: InsightView, b: InsightView): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    byCodeUnit(b.day, a.day) ||
    byCodeUnit(a.job, b.job) ||
    byCodeUnit(a.subject, b.subject)
  )
}

function insightView(row: InsightRecord): InsightView {
  const { runDay, ...rest } = row
  return { ...rest, day: runDay }
}

/**
 * The night shift's insights as the admin reads and dismisses them. A dismiss is one conditional update, so of two
 * admins one wins and the other is told the insight is already dismissed.
 */
export function createInsightService(deps: InsightServiceDeps): InsightService {
  const { store, insights, publisher, now = () => new Date() } = deps
  return {
    async list() {
      const rows = await store.read((tx) => insights.list(tx, { status: 'open' }))
      return { items: rows.map(insightView).sort(briefOrder) }
    },

    dismiss(id) {
      return store.transaction(async (tx) => {
        audit.note('insight.dismiss', [{ type: 'insight', id }])
        if (!(await insights.dismiss(tx, id, now()))) {
          const found = await insights.findById(tx, id)
          throw new InsightError(found === null ? 'insight.not_found' : 'insight.dismissed', id)
        }
        const row = (await insights.findById(tx, id))!
        await publisher.publish(EVT_INSIGHT_DISMISSED, {
          insightId: row.id,
          job: row.job,
          subject: row.subject,
          dismissedAt: row.dismissedAt!,
        })
        return insightView(row)
      })
    },
  }
}
