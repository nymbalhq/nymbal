// Reads: .github/workflows/registry.yml, .github/workflows/nightly-trigger.yml
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseYaml } from './workflow-yaml'

// The nightly's workflows, read for what each job may do: third-party adapter code runs in the certifying job, so
// the token that publishes the matrix must live somewhere else and only on `main`.

const REPO = fileURLToPath(new URL('../..', import.meta.url))

type Step = {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, string>
}
type Job = {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  steps: Step[]
}
type Workflow = { jobs: Record<string, Job> }

const workflow = (file: string): Workflow =>
  parseYaml(readFileSync(join(REPO, '.github', 'workflows', file), 'utf8')) as unknown as Workflow

const registry = (): Workflow => workflow('registry.yml')

const certifyingJobName = (w: Workflow): string =>
  Object.entries(w.jobs).find(([, job]) =>
    job.steps.some((step) => step.run?.includes('pnpm registry')),
  )![0]

const pagesJobs = (w: Workflow): [string, Job][] =>
  Object.entries(w.jobs).filter(([, job]) => job.permissions?.['pages'] === 'write')

/** Evaluates a job's `if` for a ref and a repository variable; only `==`, `&&` and `||` of those two. */
function runsFor(expression: string | undefined, ref: string, pagesVar: string): boolean {
  if (expression === undefined) return false
  const body = expression
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
  return body.split('||').some((alternative) =>
    alternative.split('&&').every((clause) => {
      const m = /^\s*(github\.ref|vars\.REGISTRY_PAGES)\s*(==|!=)\s*'([^']*)'\s*$/.exec(clause)
      if (m === null) throw new Error(`cannot read the job's condition: ${clause}`)
      const actual = m[1] === 'github.ref' ? ref : pagesVar
      return m[2] === '==' ? actual === m[3] : actual !== m[3]
    }),
  )
}

/** A path as the workflow spells it, with the runner's temp directory written one way. */
const samePath = (path: string | undefined): string | undefined =>
  path?.replace(/^"|"$/g, '').replace(/\$\{\{\s*runner\.temp\s*\}\}/g, '$RUNNER_TEMP')

describe('AC-19: the Pages token never sits beside third-party code, and only main publishes', () => {
  it('AC-19: the certifying job holds contents: read only and no secret, and exactly one other job holds pages: write', () => {
    const w = registry()
    const certifying = certifyingJobName(w)

    expect(w.jobs[certifying]!.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(w.jobs[certifying])).not.toMatch(/secrets\.|GITHUB_TOKEN/)
    expect(
      pagesJobs(w)
        .map(([name]) => name)
        .filter((name) => name !== certifying),
    ).toHaveLength(1)
    expect(pagesJobs(w).map(([name]) => name)).not.toContain(certifying)
  })

  it('AC-19: the Pages job needs the certifying job and has no step but deploy-pages: no checkout and no run step', () => {
    const w = registry()
    const certifying = certifyingJobName(w)
    const job = pagesJobs(w)[0]?.[1]

    expect(job?.needs === undefined ? [] : [job.needs].flat()).toContain(certifying)
    expect(job?.steps.map((step) => step.uses?.split('@')[0])).toEqual(['actions/deploy-pages'])
    expect(job?.steps.filter((step) => step.run !== undefined)).toEqual([])
  })

  it('AC-19: the Pages job runs for the main ref with REGISTRY_PAGES true, and for no other ref or value', () => {
    const job = pagesJobs(registry())[0]?.[1]
    const cases = [
      ['refs/heads/main', 'true'],
      ['refs/heads/main', 'false'],
      ['refs/heads/main', ''],
      ['refs/heads/dev', 'true'],
      ['refs/heads/dev', ''],
    ] as const

    expect(cases.filter(([ref, value]) => runsFor(job?.if, ref, value))).toEqual([
      ['refs/heads/main', 'true'],
    ])
  })

  it('AC-19: the nightly trigger dispatches registry.yml on both dev and main', () => {
    const refs = workflow('nightly-trigger.yml')
      .jobs['dispatch']!.steps.flatMap((step) =>
        [...(step.run ?? '').matchAll(/gh workflow run registry\.yml --ref (\S+)/g)].map(
          (m) => m[1]!,
        ),
      )
      .sort()

    expect(refs).toEqual(['dev', 'main'])
  })

  it('AC-19: the certifying step passes --matrix at the path one restore and one save of a registry-matrix- cache both name', () => {
    const w = registry()
    const steps = w.jobs[certifyingJobName(w)]!.steps
    const passed = steps
      .map((step, index) => ({
        index,
        path: /--matrix[= ]+("[^"]+"|\S+)/.exec(step.run ?? '')?.[1],
      }))
      .filter((found) => found.path !== undefined)
    const cacheSteps = (action: string) =>
      steps
        .map((step, index) => ({ step, index }))
        .filter(
          ({ step }) =>
            step.uses?.startsWith(`actions/cache/${action}@`) &&
            step.with?.['key']?.startsWith('registry-matrix-'),
        )
    const restores = cacheSteps('restore')
    const saves = cacheSteps('save')

    expect(passed).toHaveLength(1)
    expect(restores).toHaveLength(1)
    expect(saves).toHaveLength(1)
    expect(samePath(restores[0]!.step.with?.['path'])).toBe(samePath(passed[0]!.path))
    expect(samePath(saves[0]!.step.with?.['path'])).toBe(samePath(passed[0]!.path))
    expect(restores[0]!.index).toBeLessThan(passed[0]!.index)
    expect(saves[0]!.index).toBeGreaterThan(passed[0]!.index)
  })
})
