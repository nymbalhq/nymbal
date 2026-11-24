import type { InsightFacts, InsightSeverity } from './events/payloads.js'

export type InsightStatus = 'open' | 'dismissed'

/** One insight as the admin and its agents read it. */
export interface InsightView {
  id: string
  job: string
  subject: string
  /** The store day the night ran for, `YYYY-MM-DD`, as `insight.created.v1` names it. */
  day: string
  /** The closed day the figures end on. */
  dataDay: string
  severity: InsightSeverity
  summary: string
  facts: InsightFacts
  status: InsightStatus
  createdAt: string
  dismissedAt: string | null
  /** What an AI model suggests doing about it, shown only once it passed the store's checks. */
  guidance: string | null
  /** True when the model's guidance was written and did not pass the store's checks. */
  guidanceWithheld: boolean
}

export interface InsightList {
  items: InsightView[]
}
