import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type PlanInput,
  plan,
  run,
  STORE_SETS,
  type StepSpec,
  type StoreSet,
} from '../../scripts/gate'
import { COMPOSE_PORT_VARS, type ExpectedBlock, expectedBlock, type PortField } from './stack-table'

// Acceptance tests for P2-14 AC-3: a gate:full plan in stack slot k names slot k's compose project and ports. Each plan
// is rehearsed: every step runs through the gate's own `run`, in a scratch directory where `pnpm`, `docker` and
// `node_modules/.bin/tsx` are stand-ins that record their arguments and environment. So what is asserted is what each
// tool would be started with, however the command spells it.

const BASE_INPUT: PlanInput = {
  full: true,
  base: 'abc1234',
  changed: ['packages/sdk/src/client.ts'],
  // Non-empty, so stryker is a step that runs rather than one skipped for having nothing to do.
  mutated: ['packages/sdk/src/client.ts'],
}

/** `PlanInput` with the stack field the spec adds (`PlanInput.stack?: StackBlock`). */
type StackPlanInput = PlanInput & { stack?: ExpectedBlock }

function fullPlan(extra: Partial<StackPlanInput> = {}): StepSpec[] {
  const input: StackPlanInput = { ...BASE_INPUT, ...extra }
  return plan(input).steps
}

type Call = { step: string; tool: string; args: string; env: Record<string, string> }

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const RECORDER = `#!/bin/sh
out=$(mktemp "$NYMBAL_REHEARSAL_OUT/call.XXXXXX")
{ printf '%s\\n' "$(basename "$0")"; printf '%s\\n' "$*"; env; } > "$out"
`

/** Runs every step of the plan with the tools replaced by recorders, and returns each tool call. */
async function rehearse(steps: StepSpec[], extraEnv: Record<string, string> = {}): Promise<Call[]> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-stack-')))
  created.push(root)
  const bin = join(root, 'bin')
  const cwd = join(root, 'work')
  const out = join(root, 'calls')
  for (const dir of [bin, cwd, out, join(cwd, 'node_modules/.bin'), join(cwd, 'apps/admin/dist')]) {
    mkdirSync(dir, { recursive: true })
  }
  // The admin E2E step refuses to start without the admin build it serves.
  writeFileSync(join(cwd, 'apps/admin/dist/index.html'), '')
  for (const path of [join(bin, 'pnpm'), join(bin, 'docker'), join(cwd, 'node_modules/.bin/tsx')]) {
    writeFileSync(path, RECORDER)
    chmodSync(path, 0o755)
  }
  const runnable = steps
    .filter((step) => step.skip === undefined)
    .map((step) => {
      const { needs: _needs, ...rest } = step
      return { ...rest, command: `export NYMBAL_REHEARSAL_STEP='${step.name}'; ${step.command}` }
    })
  // A clean environment: nothing from the shell that runs the tests can stand in for what the plan sets.
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, NYMBAL_REHEARSAL_OUT: out, ...extraEnv }
  const result = await run(runnable, { cwd, budgetMs: 600_000, env })
  expect(result.steps.filter((s) => s.status !== 'ok').map((s) => s.name)).toEqual([])
  return readdirSync(out).map((name) => {
    const [tool = '', args = '', ...lines] = readFileSync(join(out, name), 'utf8').split('\n')
    const vars: Record<string, string> = {}
    for (const line of lines) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (m) vars[m[1]!] = m[2]!
    }
    return { step: vars.NYMBAL_REHEARSAL_STEP ?? '?', tool, args, env: vars }
  })
}

/** The service URL variables a step can carry, by the block port each must name. */
const URL_VARS: Record<string, PortField> = {
  NYMBAL_TEST_POSTGRES_URL: 'postgres',
  DATABASE_URL: 'postgres',
  NYMBAL_TEST_MAILPIT_URL: 'mailpitUi',
  NYMBAL_TEST_REDIS_URL: 'redis',
  REDIS_URL: 'redis',
  NYMBAL_TEST_S3_ENDPOINT: 'minio',
}

/** Every service URL a tool is started with whose port is not the block's, as `step: VAR=url (want port)`. */
function strayUrls(calls: Call[], block: ExpectedBlock): string[] {
  return calls.flatMap((call) =>
    Object.entries(URL_VARS)
      .filter(([name]) => call.env[name] !== undefined)
      .filter(([name, field]) => new URL(call.env[name]!).port !== String(block[field]))
      .map(
        ([name, field]) => `${call.step}: ${name}=${call.env[name]} (want port ${block[field]})`,
      ),
  )
}

/** The compose project a `docker compose` call acts on: `-p`/`--project-name`, else COMPOSE_PROJECT_NAME, else compose.yaml's `nymbal`. */
function composeProject(call: Call): string {
  const words = call.args.split(/\s+/)
  const flag = words.findIndex((w) => w === '-p' || w === '--project-name')
  const inline = /^--project-name=(.+)$/.exec(
    words.find((w) => w.startsWith('--project-name=')) ?? '',
  )
  return (flag >= 0 ? words[flag + 1] : inline?.[1]) ?? call.env.COMPOSE_PROJECT_NAME ?? 'nymbal'
}

const SLOT = 3
const STORES = Object.keys(STORE_SETS) as StoreSet[]

describe('AC-3: a gate:full plan in slot 3 uses slot 3 services', () => {
  it.each(STORES)(
    'AC-3 (a): with --stores %s, compose brings up project nymbal-s3 with the five port variables at slot 3',
    async (stores) => {
      const block = expectedBlock(SLOT)
      const calls = await rehearse(fullPlan({ stack: block, stores }))
      const compose = calls.filter((call) => call.tool === 'docker')
      expect(compose.map((call) => call.step)).toEqual(['compose up'])
      const call = compose[0]!
      expect(call.args.split(/\s+/)).toEqual(
        expect.arrayContaining(['compose', 'up', '-d', '--wait']),
      )
      expect(composeProject(call)).toBe(block.project)
      const ports = Object.fromEntries(
        Object.keys(COMPOSE_PORT_VARS).map((name) => [name, call.env[name]]),
      )
      expect(ports).toEqual(
        Object.fromEntries(
          Object.entries(COMPOSE_PORT_VARS).map(([name, field]) => [name, String(block[field])]),
        ),
      )
    },
  )

  it.each(STORES)(
    'AC-3 (b): with --stores %s, every step that names Postgres, Mailpit, Redis or S3 names 54629, 18325, 64099 or 59300',
    async (stores) => {
      const block = expectedBlock(SLOT)
      const calls = await rehearse(fullPlan({ stack: block, stores }))
      expect(strayUrls(calls, block)).toEqual([])
      // Each service is named somewhere, so an empty sweep cannot pass for a plan that names none.
      const named = new Set(
        calls.flatMap((call) => Object.keys(call.env).filter((name) => name in URL_VARS)),
      )
      expect([...named].filter((name) => name.startsWith('NYMBAL_TEST_')).sort()).toEqual(
        Object.keys(URL_VARS)
          .filter((name) => name.startsWith('NYMBAL_TEST_'))
          .sort(),
      )
      // No command spells a slot 0 port, inline or otherwise.
      const slot0 = expectedBlock(0)
      const pinned = fullPlan({ stack: block, stores }).filter((step) =>
        [slot0.postgres, slot0.mailpitUi, slot0.redis, slot0.minio, slot0.mailpitSmtp].some(
          (port) => new RegExp(`:${port}\\b`).test(step.command),
        ),
      )
      expect(pinned.map((step) => step.name)).toEqual([])
    },
  )

  it('AC-3 (b): an explicit minioPort (NYMBAL_MINIO_PORT) still wins over the block, for compose and the S3 endpoint alike', async () => {
    const block = expectedBlock(SLOT)
    const calls = await rehearse(fullPlan({ stack: block, minioPort: '59999' }), {
      NYMBAL_MINIO_PORT: '59999',
    })
    const compose = calls.find((call) => call.tool === 'docker')
    const s3 = calls.filter((call) => call.env.NYMBAL_TEST_S3_ENDPOINT !== undefined)
    expect(s3.length).toBeGreaterThan(0)
    expect(new Set(s3.map((call) => new URL(call.env.NYMBAL_TEST_S3_ENDPOINT!).port))).toEqual(
      new Set([compose?.env.NYMBAL_MINIO_PORT]),
    )
    expect(compose?.env.NYMBAL_MINIO_PORT).toBe('59999')
  })

  it('AC-3 (c): every step given the Mailpit API is given its SMTP address at slot 3, localhost:11325', async () => {
    const block = expectedBlock(SLOT)
    const calls = await rehearse(fullPlan({ stack: block }))
    const mail = calls.filter((call) => call.env.NYMBAL_TEST_MAILPIT_URL !== undefined)
    expect(mail.length).toBeGreaterThan(0)
    expect(mail.map((call) => `${call.step}: ${call.env.NYMBAL_TEST_MAILPIT_SMTP}`)).toEqual(
      mail.map((call) => `${call.step}: localhost:${block.mailpitSmtp}`),
    )
  })

  it('AC-3 (d): every E2E step starts Playwright with NYMBAL_STACK_SLOT=3', async () => {
    const block = expectedBlock(SLOT)
    const steps = fullPlan({ stack: block })
    const e2eSteps = steps.filter((step) => step.name.startsWith('e2e ')).map((step) => step.name)
    const calls = await rehearse(steps)
    const playwright = calls.filter((call) => /\bplaywright\b/.test(call.args))
    expect(playwright.map((call) => call.step).sort()).toEqual([...e2eSteps].sort())
    expect(playwright.map((call) => `${call.step}: ${call.env.NYMBAL_STACK_SLOT}`)).toEqual(
      playwright.map((call) => `${call.step}: ${String(block.slot)}`),
    )
  })
})

describe('AC-3: slot 0 is today', () => {
  it.each(STORES)(
    'AC-3 (e): with --stores %s, a plan with stackBlock(0) has exactly the steps of a plan with no stack',
    (stores) => {
      expect(fullPlan({ stack: expectedBlock(0), stores })).toEqual(fullPlan({ stores }))
    },
  )

  it("AC-3 (e): a slot 0 plan composes today's project on today's ports and points every step at them", async () => {
    const block = expectedBlock(0)
    const calls = await rehearse(fullPlan({ stack: block, stores: 'postgres-redis' }))
    const compose = calls.filter((call) => call.tool === 'docker')
    expect(compose.map((call) => call.args)).toEqual(['compose up -d --wait'])
    expect(composeProject(compose[0]!)).toBe('nymbal')
    expect(strayUrls(calls, block)).toEqual([])
  })

  it('AC-3 (f): a slot 0 plan gives every step that has the Mailpit API its SMTP address, localhost:11025', async () => {
    const block = expectedBlock(0)
    const calls = await rehearse(fullPlan({ stack: block }))
    const mail = calls.filter((call) => call.env.NYMBAL_TEST_MAILPIT_URL !== undefined)
    expect(mail.length).toBeGreaterThan(0)
    expect(mail.map((call) => `${call.step}: ${call.env.NYMBAL_TEST_MAILPIT_SMTP}`)).toEqual(
      mail.map((call) => `${call.step}: localhost:${block.mailpitSmtp}`),
    )
  })
})
