export const METRICS = ['lcpMs', 'cls', 'tbtMs', 'scriptBytes'] as const
export type Metric = (typeof METRICS)[number]
export type Metrics = Record<Metric, number>

/** One page of one template, as the run measured it. */
export interface PageResult {
  template: string
  page: string
  url: string
  measured: Metrics
}

/** perf-budgets.json: template → page → the budget for each metric. */
export type Budgets = Record<string, Record<string, Metrics>>

export const NOT_MEASURED = 'not measured'
export const NO_BUDGET = 'no budget'

/** A page's verdict: `failures` names each metric over budget, or says the page was not measured or has no budget. */
export interface Verdict {
  template: string
  page: string
  ok: boolean
  failures: string[]
}

/**
 * One verdict per page that is budgeted or measured. A metric passes only when it is at or under its budget, so a NaN
 * (a page that never loaded) fails; a budgeted page with no result fails, and so does a measured page with no budget.
 */
export function checkBudgets(results: readonly PageResult[], budgets: Budgets): Verdict[] {
  const verdicts: Verdict[] = []
  const measured = new Set<string>()
  for (const result of results) {
    measured.add(`${result.template}\u0000${result.page}`)
    const budget = budgets[result.template]?.[result.page]
    const failures =
      budget === undefined
        ? [NO_BUDGET]
        : METRICS.filter((metric) => !(result.measured[metric] <= budget[metric]))
    verdicts.push({
      template: result.template,
      page: result.page,
      ok: failures.length === 0,
      failures,
    })
  }
  for (const [template, byPage] of Object.entries(budgets)) {
    for (const page of Object.keys(byPage)) {
      if (measured.has(`${template}\u0000${page}`)) continue
      verdicts.push({ template, page, ok: false, failures: [NOT_MEASURED] })
    }
  }
  return verdicts
}
