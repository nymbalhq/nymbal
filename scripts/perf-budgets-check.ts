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

/** A page's script bytes at a commit, which it may not grow past whatever its budget allows. */
export interface ScriptReference {
  commit: string
  template: string
  page: string
  scriptBytes: number
}

/** The reference files (from the repository root) that hold a page to its bytes at a commit. */
export const SCRIPT_REFERENCES = ['tests/perf/fixtures/astro-home-d2d900b.json']

/** The failure a page above its reference has. */
export const referenceFailure = (commit: string): string => `scriptBytes (reference ${commit})`

/**
 * One verdict per page that is budgeted or measured. A metric passes only when it is at or under its budget, so a NaN
 * (a page that never loaded) fails; a budgeted page with no result fails, and so does a measured page with no budget.
 * `metrics` limits the metrics judged (every one when not given); a page with a reference fails above its bytes.
 */
export function checkBudgets(
  results: readonly PageResult[],
  budgets: Budgets,
  opts: { metrics?: readonly Metric[]; references?: readonly ScriptReference[] } = {},
): Verdict[] {
  const judged = opts.metrics ?? METRICS
  const verdicts: Verdict[] = []
  const measured = new Set<string>()
  for (const result of results) {
    measured.add(`${result.template}\u0000${result.page}`)
    const budget = budgets[result.template]?.[result.page]
    const failures: string[] =
      budget === undefined
        ? [NO_BUDGET]
        : judged.filter((metric) => !(result.measured[metric] <= budget[metric]))
    for (const reference of opts.references ?? []) {
      if (reference.template !== result.template || reference.page !== result.page) continue
      if (!(result.measured.scriptBytes <= reference.scriptBytes))
        failures.push(referenceFailure(reference.commit))
    }
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
