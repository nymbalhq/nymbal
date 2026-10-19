import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parseYaml } from './workflow-yaml'

// Acceptance test for P1-10 (phase exit), AC-7: in ci.yml the `coverage` job's coverage step cannot fail the job on
// a threshold miss, writes the summary to $GITHUB_STEP_SUMMARY, and a run that crashes still fails the job.
// The job's own `run` steps (all but the install; the `uses` steps only fetch the checkout, toolchain and build) are
// executed as Actions would (bash -eo pipefail, `if:` and `continue-on-error` honoured) in a scratch project that holds
// the repo's Vitest config and package.json scripts, with one fixture service under the services threshold
// (tests/tooling/fixtures/coverage-job). The fixture covers half of it, so the 100% line threshold is missed.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURES = join(REPO, 'tests/tooling/fixtures/coverage-job')
const WORKFLOW = join(REPO, '.github/workflows/ci.yml')
const SERVICES = 'packages/platform/src/services'

type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  env?: Record<string, string>
  'continue-on-error'?: string
}
type Job = { env?: Record<string, string>; 'continue-on-error'?: string; steps?: Step[] }

const created: string[] = []
afterAll(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function coverageJob(): Job {
  const doc = parseYaml(readFileSync(WORKFLOW, 'utf8')) as { jobs?: Record<string, Job> }
  const job = doc.jobs?.['coverage']
  if (job === undefined) throw new Error('ci.yml has no coverage job')
  return job
}

function scratch(withCrash: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-coverage-job-')))
  created.push(dir)
  const rootPackage = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'coverage-job-scratch',
      private: true,
      type: 'module',
      scripts: rootPackage.scripts,
    }),
  )
  for (const f of readdirSync(REPO)) {
    if (/^vitest(?:\.[\w-]+)*\.config\.(?:ts|mts|js|mjs)$/.test(f)) {
      copyFileSync(join(REPO, f), join(dir, f))
    }
  }
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true })
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'))
  mkdirSync(join(dir, SERVICES), { recursive: true })
  copyFileSync(
    join(FIXTURES, 'fixture-service.ts.fixture'),
    join(dir, SERVICES, 'fixture-service.ts'),
  )
  copyFileSync(
    join(FIXTURES, 'fixture-service.test.ts.fixture'),
    join(dir, SERVICES, 'fixture-service.test.ts'),
  )
  if (withCrash) {
    copyFileSync(join(FIXTURES, 'crash.test.ts.fixture'), join(dir, SERVICES, 'crash.test.ts'))
  }
  return dir
}

function bash(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd,
      env,
    })
    let output = ''
    child.stdout.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr.on('data', (d: Buffer) => (output += d.toString()))
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}

const truthy = (value: string | undefined): boolean => value !== undefined && value !== 'false'

/** Runs the job's run steps as Actions would; the job fails when a step fails without continue-on-error. */
async function runJob(
  job: Job,
  cwd: string,
): Promise<{ failed: boolean; summary: string; log: string }> {
  const summaryFile = join(cwd, 'step-summary.md')
  writeFileSync(summaryFile, '')
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'NODE_OPTIONS'),
  )
  let failed = false
  let log = ''
  for (const step of job.steps ?? []) {
    if (typeof step.run !== 'string' || /\bpnpm install\b/.test(step.run)) continue
    if (step.run.includes('${{'))
      throw new Error(`a step expression this test cannot evaluate: ${step.run}`)
    if (step.shell !== undefined && step.shell !== 'bash') {
      throw new Error(`a step shell this test does not model: ${step.shell}`)
    }
    const condition = (step.if ?? 'success()').replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim()
    const runs =
      condition === 'always()' || condition === '!cancelled()'
        ? true
        : condition === 'failure()'
          ? failed
          : condition === 'success()'
            ? !failed
            : undefined
    if (runs === undefined) throw new Error(`a step condition this test does not model: ${step.if}`)
    if (!runs) continue
    const { code, output } = await bash(step.run, cwd, {
      ...inherited,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: summaryFile,
      ...job.env,
      ...step.env,
    })
    log += `$ ${step.run}\n${output}\nexit ${code}\n`
    if (code !== 0 && !truthy(step['continue-on-error'])) failed = true
  }
  const summary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : ''
  return { failed, summary, log }
}

describe('AC-7: coverage never blocks alone', () => {
  it('AC-7: the coverage job passes a threshold miss and writes the summary to $GITHUB_STEP_SUMMARY, but fails a run that crashes', async () => {
    const job = coverageJob()
    const [miss, crash] = await Promise.all([
      runJob(job, scratch(false)),
      runJob(job, scratch(true)),
    ])

    expect(miss.failed, `a threshold miss alone must not fail the job\n${miss.log}`).toBe(false)
    expect(
      miss.summary.length,
      'the coverage summary is written to $GITHUB_STEP_SUMMARY',
    ).toBeGreaterThan(0)
    // A coverage summary, not a placeholder: it reports a percentage.
    expect(miss.summary).toMatch(/\d+(?:\.\d+)?\s?%/)

    expect(crash.failed, `a run that crashes must still fail the job\n${crash.log}`).toBe(true)
    expect(truthy(job['continue-on-error']), 'the coverage job is not continue-on-error').toBe(
      false,
    )
  })
})
