import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { type PlanInput, plan, run, type Step, type StepSpec } from '../../scripts/gate'

// Acceptance tests for P0-03 part 2, AC-1 and AC-2: the flags CI jobs pass to `scripts/gate.ts --full`.
// `--only` reaches `plan` as `only`; `--services external` as `services: 'external'` with the
// NYMBAL_TEST_POSTGRES_URL the CLI read as `postgresUrl`; `--no-build` as `noBuild: true` with the CLI's artefact
// check as `artefactPresent`. Each plan is rehearsed: every command is replaced by one that leaves a marker, so what
// ran is read from the scratch directory, not from the plan's own description of itself.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const GATE = join(REPO, 'scripts/gate.ts')

const CI_URL = 'postgres://ci:ci@127.0.0.1:5432/nymbal_ci'

const BASE_INPUT: PlanInput = {
  full: true,
  base: 'abc1234',
  changed: ['packages/sdk/src/client.ts'],
  // A non-empty mutate set, so that stryker is a step that runs rather than one skipped for having nothing to do.
  mutated: ['packages/sdk/src/client.ts'],
}

function fullPlan(extra: Partial<PlanInput> = {}): StepSpec[] {
  return plan({ ...BASE_INPUT, ...extra }).steps
}

const DEFAULT_NAMES = fullPlan().map((s) => s.name)
const NEED_FREE = fullPlan()
  .filter((s) => (s.needs ?? []).length === 0)
  .map((s) => s.name)
const E2E_NAMES = DEFAULT_NAMES.filter((n) => n.startsWith('e2e'))

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '-')
}

function rehearse(steps: StepSpec[]): StepSpec[] {
  return steps.map((s) => ({ ...s, command: `touch 'ran-${slug(s.name)}'` }))
}

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-ci-')))
  created.push(dir)
  return dir
}

/** Plans with `extra`, runs the rehearsal, and returns the step results and the names whose command ran. */
async function rehearsal(
  extra: Partial<PlanInput>,
): Promise<{ steps: Step[]; ran: string[]; planned: StepSpec[] }> {
  const planned = fullPlan(extra)
  const cwd = scratch()
  const result = await run(rehearse(planned), { cwd, budgetMs: 600_000 })
  const markers = new Set(readdirSync(cwd))
  const ran = planned.map((s) => s.name).filter((n) => markers.has(`ran-${slug(n)}`))
  return { steps: result.steps, ran, planned }
}

function stepNamed(steps: Step[], name: string): Step | undefined {
  return steps.find((s) => s.name === name)
}

/** The NYMBAL_TEST_POSTGRES_URL a command pins inline, if any. */
function pinnedUrl(command: string): string | undefined {
  const m = /NYMBAL_TEST_POSTGRES_URL=("[^"]*"|'[^']*'|\S+)/.exec(command)
  return m?.[1]?.replace(/^["']|["']$/g, '')
}

// ---------------------------------------------------------------------------------------------------------------
// AC-1: --only
// ---------------------------------------------------------------------------------------------------------------

describe('AC-1: --only runs exactly the named steps, in plan order', () => {
  it('AC-1: property: plan({ only }) holds exactly the named steps in plan order, whatever order they were named in', () => {
    expect(NEED_FREE.length).toBeGreaterThanOrEqual(4)
    fc.assert(
      fc.property(fc.shuffledSubarray(NEED_FREE, { minLength: 1 }), (picked) => {
        const names = fullPlan({ only: picked }).map((s) => s.name)
        expect(names).toEqual(DEFAULT_NAMES.filter((n) => picked.includes(n)))
      }),
      { numRuns: 60 },
    )
  })

  it('AC-1: running a plan with only: [sentinels, lint] runs lint then sentinels and nothing else', async () => {
    const { steps, ran } = await rehearsal({ only: ['sentinels', 'lint'] })
    expect(ran).toEqual(['lint', 'sentinels'])
    expect(steps.map((s) => s.name)).toEqual(DEFAULT_NAMES.filter((n) => ran.includes(n)))
  })

  it('AC-1: gate.ts --full --only with an unknown name exits non-zero, names it and every known step, and runs nothing', () => {
    const child = spawnSync(
      TSX,
      [GATE, '--full', '--only', 'lint,no-such-step', '--base', 'HEAD'],
      {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
      },
    )
    const output = `${child.stdout}${child.stderr}`
    expect(child.status, output).not.toBe(0)
    expect(child.status, output).not.toBeNull()
    expect(output).toContain('no-such-step')
    const missing = DEFAULT_NAMES.filter((n) => !output.includes(n))
    expect(missing, output).toEqual([])
    expect(output).not.toMatch(/^running /m)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-2: --services external and --no-build
// ---------------------------------------------------------------------------------------------------------------

describe('AC-2: --services external and --no-build meet their needs only when the precondition holds', () => {
  it('AC-2: --services external with the URL set never runs compose up, runs what needs it, against that URL', async () => {
    const { steps, ran, planned } = await rehearsal({ services: 'external', postgresUrl: CI_URL })
    expect(ran).not.toContain('compose up')
    for (const name of ['integration-postgres', 'tests-fail-on-base']) {
      expect(ran, name).toContain(name)
      expect(stepNamed(steps, name)?.status, name).toBe('ok')
      const command = planned.find((s) => s.name === name)?.command ?? ''
      expect(pinnedUrl(command) ?? CI_URL, `${name}: ${command}`).toBe(CI_URL)
    }
  })

  it('AC-2: --services external without the URL skips the Postgres steps, naming NYMBAL_TEST_POSTGRES_URL', async () => {
    const { steps, ran } = await rehearsal({ services: 'external', postgresUrl: undefined })
    expect(ran).not.toContain('compose up')
    for (const name of ['integration-postgres', 'tests-fail-on-base']) {
      expect(ran, name).not.toContain(name)
      const step = stepNamed(steps, name)
      expect(step?.status, name).toBe('skipped')
      expect(step?.detail ?? '', name).toContain('NYMBAL_TEST_POSTGRES_URL')
    }
  })

  it('AC-2: --no-build with the artefact present never runs build and runs every E2E step', async () => {
    const { steps, ran } = await rehearsal({
      services: 'external',
      postgresUrl: CI_URL,
      noBuild: true,
      artefactPresent: true,
    })
    expect(E2E_NAMES.length).toBeGreaterThanOrEqual(2)
    expect(ran).not.toContain('build')
    expect(ran.filter((n) => n.startsWith('e2e'))).toEqual(E2E_NAMES)
    for (const name of E2E_NAMES) expect(stepNamed(steps, name)?.status, name).toBe('ok')
  })

  it('AC-2: --no-build without the artefact skips every E2E step, naming the artefact', async () => {
    const { steps, ran } = await rehearsal({
      services: 'external',
      postgresUrl: CI_URL,
      noBuild: true,
      artefactPresent: false,
    })
    expect(ran).not.toContain('build')
    expect(ran.filter((n) => n.startsWith('e2e'))).toEqual([])
    for (const name of E2E_NAMES) {
      const step = stepNamed(steps, name)
      expect(step?.status, name).toBe('skipped')
      expect(step?.detail ?? '', name).toMatch(/artefact|artifact/i)
    }
  })

  it('AC-2: the CI job shapes run exactly their steps: integration over services, E2E over the artefact', async () => {
    const integration = await rehearsal({
      only: ['integration-postgres'],
      services: 'external',
      postgresUrl: CI_URL,
    })
    expect(integration.ran).toEqual(['integration-postgres'])

    for (const e2e of E2E_NAMES) {
      const job = await rehearsal({
        only: [e2e],
        services: 'external',
        postgresUrl: CI_URL,
        noBuild: true,
        artefactPresent: true,
      })
      expect(job.ran, e2e).toEqual([e2e])
    }
  })

  it('AC-2: over services x URL x no-build x artefact, each step runs iff its precondition holds, and a skip names why', async () => {
    for (const external of [false, true]) {
      for (const urlSet of [false, true]) {
        for (const noBuild of [false, true]) {
          for (const artefact of [false, true]) {
            const label = `external=${external} url=${urlSet} noBuild=${noBuild} artefact=${artefact}`
            const { steps, ran } = await rehearsal({
              services: external ? 'external' : 'compose',
              postgresUrl: urlSet ? CI_URL : undefined,
              noBuild,
              artefactPresent: artefact,
            })
            const postgresMet = external ? urlSet : true
            const buildMet = noBuild ? artefact : true
            expect(ran.includes('compose up'), label).toBe(!external)
            expect(ran.includes('build'), label).toBe(!noBuild)
            expect(ran.includes('lint') && ran.includes('sentinels'), label).toBe(true)
            for (const name of ['integration-postgres', 'tests-fail-on-base']) {
              expect(ran.includes(name), `${label}: ${name}`).toBe(postgresMet)
              if (!postgresMet) {
                expect(stepNamed(steps, name)?.detail ?? '', label).toContain(
                  'NYMBAL_TEST_POSTGRES_URL',
                )
              }
            }
            for (const name of E2E_NAMES) {
              expect(ran.includes(name), `${label}: ${name}`).toBe(postgresMet && buildMet)
              if (!buildMet) {
                expect(stepNamed(steps, name)?.detail ?? '', label).toMatch(/artefact|artifact/i)
              }
            }
          }
        }
      }
    }
  })
})
