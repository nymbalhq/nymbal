import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  artefactPresent,
  type PlanInput,
  plan,
  run,
  type Step,
  type StepSpec,
} from '../../scripts/gate'

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

/** Every command replaced by one that leaves a marker; the steps named in `red` then exit 1. */
function rehearse(steps: StepSpec[], red: string[] = []): StepSpec[] {
  return steps.map((s) => ({
    ...s,
    command: `touch 'ran-${slug(s.name)}'${red.includes(s.name) ? '; exit 1' : ''}`,
  }))
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
  red: string[] = [],
): Promise<{ steps: Step[]; ran: string[]; planned: StepSpec[] }> {
  const planned = fullPlan(extra)
  const cwd = scratch()
  const result = await run(rehearse(planned, red), { cwd, budgetMs: 600_000 })
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
              // A step skipped for want of Postgres names the variable that would run it.
              const detail = stepNamed(steps, name)?.detail ?? ''
              expect(
                postgresMet || detail.includes('NYMBAL_TEST_POSTGRES_URL'),
                `${label}: ${name} skipped with detail "${detail}"`,
              ).toBe(true)
            }
            // Round 1, AC-11: the E2E steps need build only, so Postgres no longer gates them.
            for (const name of E2E_NAMES) {
              expect(ran.includes(name), `${label}: ${name}`).toBe(buildMet)
              // A step skipped for want of the build names the missing artefact.
              const detail = stepNamed(steps, name)?.detail ?? ''
              expect(
                buildMet || /artefact|artifact/i.test(detail),
                `${label}: ${name} skipped with detail "${detail}"`,
              ).toBe(true)
            }
          }
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Round 1 (review of PR #4): AC-8, AC-9, AC-11 (gate side), AC-12 (Stryker quoting)
// ---------------------------------------------------------------------------------------------------------------

/** Environment for a child gate.ts: no Postgres URL and no git variables leaking in from the parent. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NYMBAL_TEST_POSTGRES_URL
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return { ...env, ...extra }
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

type CliRun = { code: number | null; output: string; steps: Step[] }

function gateCli(cwd: string, args: string[], env: Record<string, string>): Promise<CliRun> {
  return new Promise((resolvePromise) => {
    execFile(
      TSX,
      [GATE, ...args],
      { cwd, env: childEnv(env), encoding: 'utf8', timeout: 50_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : (error.code ?? null)
        const json = stdout
          .split('\n')
          .reverse()
          .find((line) => line.startsWith('{'))
        let steps: Step[] = []
        try {
          steps = json === undefined ? [] : ((JSON.parse(json) as { steps?: Step[] }).steps ?? [])
        } catch {
          steps = []
        }
        resolvePromise({ code: code as number | null, output: `${stdout}${stderr}`, steps })
      },
    )
  })
}

describe('AC-8: an --only run is red when any selected step is skipped for a failed precondition', () => {
  // A scratch repository the real gate.ts runs in: `lint` is a script that succeeds, Stryker's mutate set matches
  // nothing that changed, and one package builds but has no dist (so the artefact is absent). Every case selects
  // `lint`, which runs green, plus one step that is skipped: so "every selected step was skipped" never holds.
  let repo = ''

  function scratchRepo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-only-')))
    write(
      dir,
      'package.json',
      JSON.stringify({
        name: 'gate-scratch',
        private: true,
        scripts: { lint: 'true', typecheck: 'true', sentinels: 'true' },
      }),
    )
    write(dir, 'stryker.config.mjs', "export default { mutate: ['src/**/*.ts'] }\n")
    write(dir, 'src/index.ts', 'export {}\n')
    write(
      dir,
      'packages/lib/package.json',
      JSON.stringify({ name: 'lib', scripts: { build: 'tsup' } }),
    )
    const git = (args: string[]): void => {
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: dir, env: childEnv({}), stdio: 'ignore' },
      )
    }
    git(['init', '-q'])
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'scratch'])
    return dir
  }

  beforeAll(() => {
    repo = scratchRepo()
  })
  afterAll(() => {
    if (repo !== '') rmSync(repo, { recursive: true, force: true })
  })

  const COMMON = ['--full', '--base', 'HEAD', '--json']

  const CASES: Array<{
    why: string
    args: string[]
    env: Record<string, string>
    skipped: string
    detail: RegExp
  }> = [
    {
      why: 'NYMBAL_TEST_POSTGRES_URL unset under --services external',
      args: ['--only', 'lint,integration-postgres', '--services', 'external'],
      env: {},
      skipped: 'integration-postgres',
      detail: /NYMBAL_TEST_POSTGRES_URL/,
    },
    {
      why: 'the artefact missing under --no-build',
      args: ['--only', 'lint,e2e astro', '--services', 'external', '--no-build'],
      env: { NYMBAL_TEST_POSTGRES_URL: CI_URL },
      skipped: 'e2e astro',
      detail: /artefact|artifact/i,
    },
    {
      why: 'a need that --only leaves out',
      args: ['--only', 'lint,integration-postgres'],
      env: {},
      skipped: 'integration-postgres',
      detail: /compose up/,
    },
  ]

  it.concurrent.for(CASES)(
    'AC-8: one green step plus one skipped for $why exits non-zero',
    async ({ args, env, skipped, detail }, { expect }) => {
      const { code, output, steps } = await gateCli(repo, [...COMMON, ...args], env)
      expect(stepNamed(steps, 'lint')?.status, output).toBe('ok')
      const skip = stepNamed(steps, skipped)
      expect(skip?.status, output).toBe('skipped')
      expect(skip?.detail ?? '', output).toMatch(detail)
      expect(code, output).toBe(1)
    },
  )

  it('AC-8: one green step plus one idle skip (nothing to mutate) stays green', async () => {
    const { code, output, steps } = await gateCli(repo, [...COMMON, '--only', 'lint,stryker'], {})
    expect(stepNamed(steps, 'lint')?.status, output).toBe('ok')
    expect(stepNamed(steps, 'stryker')?.status, output).toBe('skipped')
    expect(code, output).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** Every output the artefact must hold, relative to the root of the tree `artefactTree` lays out. */
const EXPECTED_OUTPUTS = [
  'packages/alpha/dist',
  'packages/beta/dist',
  'templates/astro/dist',
  'templates/nextjs/.next',
  'apps/admin/dist',
]

/** A repository-shaped tree with a complete build: two built packages, one that does not build, both templates, admin. */
function artefactTree(): string {
  const root = scratch()
  const manifest = (name: string, build?: string): string =>
    JSON.stringify({ name, ...(build === undefined ? {} : { scripts: { build } }) })
  write(root, 'packages/alpha/package.json', manifest('@nymbalhq/alpha', 'tsup'))
  write(root, 'packages/alpha/dist/index.js', 'export {}\n')
  write(root, 'packages/beta/package.json', manifest('@nymbalhq/beta', 'tsup'))
  write(root, 'packages/beta/dist/index.js', 'export {}\n')
  write(root, 'packages/fixtures-only/package.json', manifest('@nymbalhq/fixtures-only'))
  write(root, 'templates/astro/package.json', manifest('@nymbalhq/template-astro', 'astro build'))
  write(root, 'templates/astro/dist/index.html', '<!doctype html>\n')
  write(root, 'templates/nextjs/package.json', manifest('@nymbalhq/template-nextjs', 'next build'))
  write(root, 'templates/nextjs/.next/BUILD_ID', 'scratch\n')
  write(root, 'apps/admin/package.json', manifest('@nymbalhq/admin', 'tsc -b && vite build'))
  write(root, 'apps/admin/dist/index.html', '<!doctype html>\n')
  return root
}

describe('AC-9: artefactPresent requires every expected build output', () => {
  it('AC-9: property: the tree is present iff no expected output is missing (a package with no build needs no dist)', () => {
    expect(typeof artefactPresent, 'scripts/gate.ts exports artefactPresent(root)').toBe('function')
    fc.assert(
      fc.property(fc.subarray(EXPECTED_OUTPUTS), (removed) => {
        const root = artefactTree()
        for (const path of removed) rmSync(join(root, path), { recursive: true, force: true })
        expect(artefactPresent(root), `removed: [${removed.join(', ')}]`).toBe(removed.length === 0)
      }),
      { numRuns: 40, examples: EXPECTED_OUTPUTS.map((path) => [[path]]) },
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('AC-11: the E2E steps need build only, not compose up', () => {
  const POSTGRES_STEPS = ['integration-postgres', 'tests-fail-on-base']

  it('AC-11: with compose up red, every E2E step still runs while the Postgres steps are skipped', async () => {
    const { steps, ran } = await rehearsal({}, ['compose up'])
    expect(stepNamed(steps, 'compose up')?.status).toBe('red')
    for (const name of POSTGRES_STEPS) expect(ran, name).not.toContain(name)
    expect(ran.filter((n) => n.startsWith('e2e'))).toEqual(E2E_NAMES)
  })

  it('AC-11: --services external without a URL, over a present artefact, runs every E2E step and skips the Postgres ones', async () => {
    const { steps, ran } = await rehearsal({
      services: 'external',
      postgresUrl: undefined,
      noBuild: true,
      artefactPresent: true,
    })
    for (const name of POSTGRES_STEPS) {
      expect(stepNamed(steps, name)?.detail ?? '', name).toContain('NYMBAL_TEST_POSTGRES_URL')
    }
    expect(ran.filter((n) => n.startsWith('e2e'))).toEqual(E2E_NAMES)
  })

  it('AC-11: --only with build and the E2E steps (compose up left out) runs them all', async () => {
    const { ran } = await rehearsal({ only: ['build', ...E2E_NAMES] })
    expect(ran).toEqual(['build', ...E2E_NAMES])
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** The argv a step's command hands to Stryker, read by running it under sh with stubs that print their arguments. */
function strykerArgv(command: string, cwd: string): string[] {
  const print = `printf '%s\\037' "$@"`
  const stub = join(cwd, 'node_modules/.bin/stryker')
  write(cwd, 'node_modules/.bin/stryker', `#!/bin/sh\n${print}\n`)
  execFileSync('chmod', ['755', stub])
  const script = `pnpm() { ${print}; }\nnpx() { ${print}; }\nstryker() { ${print}; }\n${command}\n`
  const child = spawnSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8' })
  if (child.status !== 0) {
    throw new Error(`sh exited ${child.status}: ${child.stderr}\ncommand: ${command}`)
  }
  return child.stdout.split('\x1f').slice(0, -1)
}

function mutateArgument(argv: string[]): string | undefined {
  const at = argv.findIndex((a) => a === '--mutate' || a.startsWith('--mutate='))
  if (at === -1) return undefined
  const arg = argv[at] as string
  return arg.startsWith('--mutate=') ? arg.slice('--mutate='.length) : argv[at + 1]
}

describe('AC-12: the Stryker --mutate argument is shell-quoted', () => {
  // Anything a file name may hold except the comma that joins the list (and NUL, newline, \x1f, used above).
  const PATH_CHARS = [...'abcXYZ019/._- \'"$`\;&|()*?[]!#~{}<>=%^@+']

  it('AC-12: property: whatever the changed paths hold, Stryker receives exactly them in --mutate', () => {
    const cwd = scratch()
    const path = fc
      .string({ unit: fc.constantFrom(...PATH_CHARS), minLength: 1, maxLength: 14 })
      .map((s) => `packages/sdk/src/${s}.ts`)
    fc.assert(
      fc.property(fc.array(path, { minLength: 1, maxLength: 4 }), (mutated) => {
        const stryker = plan({ ...BASE_INPUT, mutated }).steps.find((s) => s.name === 'stryker')
        expect(stryker?.skip, 'stryker runs when the mutate set is not empty').toBeUndefined()
        const command = stryker?.command ?? ''
        const received = mutateArgument(strykerArgv(command, cwd))
        expect(received?.split(','), command).toEqual(mutated)
      }),
      {
        numRuns: 60,
        examples: [
          [["packages/sdk/src/it's.ts"]],
          [['packages/sdk/src/a b.ts', "packages/x/'$(id)'.ts"]],
        ],
      },
    )
  })
})
