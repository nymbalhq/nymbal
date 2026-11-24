import { describe, expect, it } from 'vitest'
import { parseYaml, type Yaml } from '../../../tests/tooling/workflow-yaml.js'
import { renderWorkflow, type PackageManager } from '../src/index.js'

// The store workflow's second job, `auto-update`: the check a Renovate pull request waits for before it may merge
// itself. Renovate reads a skipped check as green, so the job must run on every pull request whatever its branch, and
// it must see the commit before the merge. Read with the repo's block-YAML reader.

/** Per package manager: how its project runs the installed CLI. */
const UPDATE_CHECK: Record<PackageManager, string> = {
  npm: 'npx nymbal update-check',
  pnpm: 'pnpm exec nymbal update-check',
  'yarn-classic': 'yarn run nymbal update-check',
  'yarn-berry': 'yarn exec nymbal update-check',
  bun: 'bunx nymbal update-check',
}
const PMS = Object.keys(UPDATE_CHECK) as PackageManager[]

type YamlMap = { [key: string]: Yaml }
/** The mapping, or an empty one, so a missing job fails on the assertion that reads it. */
const mapOr = (value: Yaml | undefined): YamlMap =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
const stepsOf = (job: YamlMap): YamlMap[] =>
  Array.isArray(job['steps']) ? job['steps'].map((s) => mapOr(s)) : []

function read(pm: PackageManager) {
  const jobs = mapOr(mapOr(parseYaml(renderWorkflow(pm)))['jobs'])
  return { jobs, verify: mapOr(jobs['verify']), job: mapOr(jobs['auto-update']) }
}

describe('AC-11: renderWorkflow gains the auto-update job', () => {
  for (const pm of PMS) {
    it(`AC-11: ${pm}: auto-update runs on every pull request with no branch condition, no permissions and no needs`, () => {
      const { job } = read(pm)

      expect(job['if']).toBe("github.event_name == 'pull_request'")
      expect(Object.keys(job).filter((key) => key === 'permissions' || key === 'needs')).toEqual([])
    })

    it(`AC-11: ${pm}: auto-update checks out two commits deep, sets up and installs exactly as verify does, ends with ${UPDATE_CHECK[pm]}, and no run line of any job expands an expression`, () => {
      const { jobs, verify, job } = read(pm)
      const verifySteps = stepsOf(verify)
      const steps = stepsOf(job)

      const checkout = steps[0] ?? {}
      expect(checkout['uses']).toBe(verifySteps[0]!['uses'])
      expect(mapOr(checkout['with'])['fetch-depth']).toBe('2')
      // Between checkout and the last step: verify's own setup, setup-node inputs and frozen install.
      expect(steps.slice(1, -1)).toEqual(verifySteps.slice(1, -1))
      const runs = steps
        .filter((s) => typeof s['run'] === 'string')
        .map((s) => String(s['run']).trim())
      expect(runs.at(-1)).toBe(UPDATE_CHECK[pm])
      expect(steps.at(-1)).toEqual({ run: UPDATE_CHECK[pm] })

      const expanding = Object.values(jobs)
        .flatMap((j) => stepsOf(mapOr(j)))
        .map((s) => s['run'])
        .filter((run) => typeof run === 'string' && run.includes('${{'))
      expect(expanding).toEqual([])
    })
  }
})
