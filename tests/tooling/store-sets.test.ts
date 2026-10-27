// Reads: scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts
// Reads: .github/workflows/nightly.yml, .github/workflows/ci.yml, nymbal.config.ts
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { plan, POSTGRES_URL, type StepSpec } from '../../scripts/gate'
import {
  cleanupScratch,
  GATE_PACKAGE_JSON,
  gateCli,
  REPO,
  scratchRepo,
  STRYKER_CONFIG,
  TSX,
} from './scratch-gate'
import { parseYaml, type Yaml } from './workflow-yaml'

// AC-7, the parts that prove the matrix without running it: the repo-root nymbal.config.ts takes its stores from
// NYMBAL_COMMAND_STORE, NYMBAL_DOCUMENT_STORE, NYMBAL_EVENT_BUS and NYMBAL_REDIS_PREFIX, defaulting to SQLite and
// in-memory; `gate.ts --full --stores <set>` runs the three E2E steps on that set, with the services it needs, and
// sqlite-memory is the default plan; nightly.yml runs postgres-redis and postgres-jsonb × astro, nextjs and admin with
// Postgres and Redis. The per-run database and prefix are tests/stores/e2e-harness.test.ts (it needs the services).
// Also: every service-backed store suite is collected by a Vitest project that CI's integration job and gate:full
// run, with NYMBAL_TEST_REDIS_URL.

const exec = promisify(execFile)

afterEach(cleanupScratch)

const SETS = {
  'sqlite-memory': { commandStore: 'sqlite', documentStore: 'in-memory', eventBus: 'in-process' },
  'postgres-redis': { commandStore: 'postgres', documentStore: 'redis', eventBus: 'redis-streams' },
  'postgres-jsonb': {
    commandStore: 'postgres',
    documentStore: 'postgres-jsonb',
    eventBus: 'in-process',
  },
} as const
type SetName = keyof typeof SETS

const REDIS_COMPOSE = 'localhost:63799'
const POSTGRES_COMPOSE = new URL(POSTGRES_URL).host

const LOAD = `import(process.env.PRIMITIVES_CONFIG_URL).then(async (m) => {
  const { config } = await m.loadConfig(process.env.PRIMITIVES_REPO)
  process.stdout.write('\\n' + JSON.stringify(config.infrastructure) + '\\n')
})`

/** The repo-root config as loadConfig reads it in a fresh process under `env` (the store variables unset first). */
async function rootInfrastructure(env: Record<string, string>): Promise<Record<string, unknown>> {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'NYMBAL_COMMAND_STORE',
    'NYMBAL_DOCUMENT_STORE',
    'NYMBAL_EVENT_BUS',
    'NYMBAL_REDIS_PREFIX',
  ]) {
    delete base[key]
  }
  const { stdout } = await exec(TSX, ['--eval', LOAD], {
    cwd: REPO,
    env: {
      ...base,
      ...env,
      PRIMITIVES_REPO: REPO,
      PRIMITIVES_CONFIG_URL: pathToFileURL(join(REPO, 'packages/config/dist/index.js')).href,
    },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? '{}') as Record<string, unknown>
}

describe('AC-7: the repo-root config takes its stores from the environment', () => {
  it('AC-7: with no store variables the root config is SQLite, in-memory and in-process, as today', async () => {
    const infra = await rootInfrastructure({})
    expect(infra).toMatchObject(SETS['sqlite-memory'])
  }, 30_000)

  it.each(['postgres-redis', 'postgres-jsonb'] as const)(
    'AC-7: NYMBAL_COMMAND_STORE, NYMBAL_DOCUMENT_STORE and NYMBAL_EVENT_BUS give the %s set, and NYMBAL_REDIS_PREFIX the Redis prefix',
    async (set) => {
      const wanted = SETS[set]
      const prefix = `e2e-primitives-${set}`
      const infra = await rootInfrastructure({
        NYMBAL_COMMAND_STORE: wanted.commandStore,
        NYMBAL_DOCUMENT_STORE: wanted.documentStore,
        NYMBAL_EVENT_BUS: wanted.eventBus,
        NYMBAL_REDIS_PREFIX: prefix,
      })
      expect(infra).toMatchObject(wanted)
      expect((infra['redis'] as { prefix?: unknown } | undefined)?.prefix).toBe(prefix)
    },
    30_000,
  )
})

const BASE_INPUT = { full: true, base: 'HEAD', changed: [] as string[], mutated: [] as string[] }
const e2eSteps = (steps: StepSpec[]): StepSpec[] => steps.filter((s) => s.name.startsWith('e2e '))

/** `NAME=value` as a whole word of a shell command. */
const assigns = (command: string, name: string, value: string): boolean =>
  new RegExp(`(^|\\s)${name}=${value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?=\\s|$)`).test(
    command,
  )

describe('AC-7: gate.ts --full --stores <set> runs the E2E steps on that set', () => {
  it.each(['postgres-redis', 'postgres-jsonb'] as const)(
    'AC-7: --stores %s puts the astro, nextjs and admin steps on that set, with the composed services they need, after compose up',
    (set: SetName) => {
      const steps = e2eSteps(plan({ ...BASE_INPUT, stores: set }).steps)
      const wanted = SETS[set]

      expect(steps.map((s) => s.name).sort()).toEqual(['e2e admin', 'e2e astro', 'e2e nextjs'])
      for (const step of steps) {
        const why = `${step.name}: ${step.command}`
        expect(assigns(step.command, 'NYMBAL_COMMAND_STORE', wanted.commandStore), why).toBe(true)
        expect(assigns(step.command, 'NYMBAL_DOCUMENT_STORE', wanted.documentStore), why).toBe(true)
        expect(assigns(step.command, 'NYMBAL_EVENT_BUS', wanted.eventBus), why).toBe(true)
        expect(step.command, why).toContain(POSTGRES_COMPOSE)
        expect(step.command.includes(REDIS_COMPOSE), why).toBe(set === 'postgres-redis')
        expect(step.needs ?? [], why).toContain('compose up')
      }
    },
  )

  it('AC-7: --stores sqlite-memory is the plan without --stores, which names no Postgres or Redis store', () => {
    const plain = plan(BASE_INPUT).steps
    const sqlite = plan({ ...BASE_INPUT, stores: 'sqlite-memory' }).steps

    expect(sqlite).toEqual(plain)
    for (const step of e2eSteps(plain)) {
      expect(assigns(step.command, 'NYMBAL_COMMAND_STORE', 'postgres'), step.command).toBe(false)
      expect(step.command, step.command).not.toContain(REDIS_COMPOSE)
    }
  })

  it('AC-7: an unknown --stores set fails the gate before any step, naming the three sets', async () => {
    const repo = scratchRepo({
      'package.json': GATE_PACKAGE_JSON,
      'stryker.config.mjs': STRYKER_CONFIG,
    })
    const run = await gateCli(repo, [
      '--full',
      '--stores',
      'mysql-mongo',
      '--only',
      'e2e admin',
      '--no-build',
      '--base',
      'HEAD',
    ])

    expect(run.code, run.output).not.toBe(0)
    const unnamed = Object.keys(SETS).filter((set) => !run.output.includes(set))
    expect(unnamed, run.output).toEqual([])
    expect(
      repo.calls().filter((call) => /playwright/.test(call)),
      run.output,
    ).toEqual([])
  })
})

type Job = {
  strategy?: { matrix?: Record<string, Yaml> }
  services?: Record<string, { image?: string } | null>
  env?: Record<string, string>
  steps?: Array<{ run?: string; env?: Record<string, string>; with?: Record<string, string> }>
}

function workflow(name: string): Record<string, Job> {
  const doc = parseYaml(readFileSync(join(REPO, '.github/workflows', name), 'utf8')) as {
    jobs: Record<string, Job>
  }
  return doc.jobs
}

const sorted = (v: Yaml | undefined): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).sort() : []

/** Everything a job's steps run or set, as text. */
const stepText = (job: Job): string =>
  JSON.stringify([job.env ?? {}, ...(job.steps ?? []).map((s) => [s.run, s.env, s.with])])

describe('AC-7: nightly.yml runs the E2E suite on each new store set', () => {
  it('AC-7: a nightly job’s matrix is postgres-redis and postgres-jsonb × astro, nextjs and admin, its steps use both matrix values, and it has Postgres and Redis services', () => {
    const found = Object.entries(workflow('nightly.yml')).flatMap(([id, job]) => {
      const matrix = job.strategy?.matrix ?? {}
      const storesKey = Object.keys(matrix).find(
        (k) => sorted(matrix[k]).join() === ['postgres-jsonb', 'postgres-redis'].join(),
      )
      const targetKey = Object.keys(matrix).find(
        (k) => sorted(matrix[k]).join() === ['admin', 'astro', 'nextjs'].join(),
      )
      return storesKey !== undefined && targetKey !== undefined
        ? [{ id, job, storesKey, targetKey }]
        : []
    })

    expect(found.map((f) => f.id).length, 'jobs with the store-set matrix').toBe(1)
    const { job, storesKey, targetKey } = found[0]!
    const text = stepText(job)
    expect(text).toContain(`matrix.${storesKey}`)
    expect(text).toContain(`matrix.${targetKey}`)
    const images = Object.values(job.services ?? {}).map((s) => s?.image ?? '')
    expect(images.filter((i) => i.startsWith('postgres:')).length).toBeGreaterThan(0)
    expect(images.filter((i) => i.startsWith('redis:')).length).toBeGreaterThan(0)
  })
})

/** The service-backed store suites (Redis, Postgres JSONB, the E2E harness). */
const SERVICE_SUITES = [
  'packages/doc-store-redis/src/contract.test.ts',
  'packages/doc-store-postgres-jsonb/src/contract.test.ts',
  'packages/event-bus-redis-streams/src/contract.test.ts',
  'packages/platform/tests/primitives/admin-tabs.test.ts',
  'packages/platform/tests/primitives/delivery-marker.test.ts',
  'packages/platform/tests/primitives/primitive-graph.test.ts',
  'tests/stores/e2e-harness.test.ts',
]

/** Each file → the Vitest projects that collect it, from `vitest list --filesOnly` over every project. */
async function collectingProjects(): Promise<Map<string, string[]>> {
  const { stdout } = await exec(
    join(REPO, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json'],
    { cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
  )
  const listed = JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{
    file: string
    projectName?: string
  }>
  const byFile = new Map<string, string[]>()
  for (const { file, projectName } of listed) {
    const path = relative(REPO, file)
    byFile.set(path, [...(byFile.get(path) ?? []), projectName ?? ''])
  }
  return byFile
}

/** The `--project` names in a command line. */
const projectsIn = (command: string): string[] =>
  [...command.matchAll(/--project[ =]['"]?([\w:-]+)/g)].map((m) => m[1]!)

describe('AC-2, AC-3, AC-5: the store suites on Redis and Postgres JSONB run in the PR integration job and in gate:full', () => {
  it('AC-2, AC-3: the integration job sets NYMBAL_TEST_REDIS_URL and NYMBAL_TEST_POSTGRES_URL and runs a project that collects every service-backed suite', async () => {
    const job = workflow('ci.yml')['integration']!
    const env = {
      ...(job.env ?? {}),
      ...Object.assign({}, ...(job.steps ?? []).map((s) => s.env ?? {})),
    }
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining(['NYMBAL_TEST_REDIS_URL', 'NYMBAL_TEST_POSTGRES_URL']),
    )
    // Projects the job names, directly or through a gate step it runs with --only.
    const full = plan(BASE_INPUT).steps
    const run = (job.steps ?? []).map((s) => s.run ?? '')
    const viaGate = run.flatMap((line) => {
      const only = /--only\s+"?([^"\s]+(?:,[^"\s]+)*)"?/.exec(line)?.[1]
      if (only === undefined || !line.includes('scripts/gate.ts')) return []
      return only
        .split(',')
        .flatMap((name) => projectsIn(full.find((s) => s.name === name)?.command ?? ''))
    })
    const ran = new Set([...run.flatMap(projectsIn), ...viaGate])

    const collected = await collectingProjects()
    const missing = SERVICE_SUITES.filter(
      (file) => !(collected.get(file) ?? []).some((p) => ran.has(p)),
    )
    expect(
      missing,
      `collected: ${JSON.stringify(SERVICE_SUITES.map((f) => [f, collected.get(f)]))}`,
    ).toEqual([])
    expect(SERVICE_SUITES.length - missing.length).toBe(SERVICE_SUITES.length)
  }, 60_000)

  it('AC-2, AC-3: gate:full runs every project that collects a service-backed suite, with NYMBAL_TEST_REDIS_URL', async () => {
    const collected = await collectingProjects()
    const projects = new Set(SERVICE_SUITES.flatMap((file) => collected.get(file) ?? []))
    const steps = plan(BASE_INPUT).steps

    expect(projects.size).toBeGreaterThan(0)
    const unrun = [...projects].filter(
      (p) =>
        !steps.some(
          (s) => projectsIn(s.command).includes(p) && s.command.includes('NYMBAL_TEST_REDIS_URL='),
        ),
    )
    expect(unrun).toEqual([])
  }, 60_000)
})
