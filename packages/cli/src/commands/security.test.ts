import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import repoConfig from '../../../../nymbal.config.js'
import { cliEnv, closedPort, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import {
  startFakeCloudflare,
  type FakeCloudflare,
  type Plan,
} from '../../../security-cloudflare/src/tests/fake-cloudflare.js'
import type { SpecPlan } from '../../../security-cloudflare/src/tests/support.js'

// AC-7: `nymbal security:plan [--json]`, `security:apply`, `security:drift [--json]` and `security:inspect` against a
// fake Cloudflare API: exit 0 done or in sync, 1 drift, 2 a config, credential or API error (and on a `middleware`
// store), and the token never in the output. Spawns the built CLI (`pnpm build` first).

const COMMANDS = [
  ['security:plan'],
  ['security:plan', '--json'],
  ['security:apply'],
  ['security:drift'],
  ['security:drift', '--json'],
  ['security:inspect'],
] as const

const GEO = 'nymbal:geo:block'
const CUSTOM = 'http_request_firewall_custom'

let fake: FakeCloudflare
const dirs: string[] = []

beforeAll(async () => {
  fake = await startFakeCloudflare()
})
afterAll(async () => {
  await fake.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Project {
  dir: string
  env: NodeJS.ProcessEnv
  security: Record<string, unknown>
}

/**
 * A project whose nymbal.config.ts is the repository's with `security` replaced; the zone and token come from the
 * environment the CLI runs in, as `env()` reads them in a real project.
 */
function project(opts: {
  apiBase: string
  zoneId: string
  token: string
  adapter?: 'cloudflare' | 'middleware'
  rateLimit?: Record<string, { requests: number; window: string; action: string }>
}): Project {
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-cf-cli-'))
  dirs.push(dir)
  const security = {
    ...repoConfig.security,
    adapter: opts.adapter ?? 'cloudflare',
    rateLimit: opts.rateLimit ?? {
      '/api/auth/login': { requests: 10, window: '1m', action: 'block' },
    },
    botProtection: { mode: 'off', allowList: [] },
    geo: { block: ['RU', 'KP'] },
    customRules: [
      { name: 'no-trace', expression: '(http.request.method eq "TRACE")', action: 'block' },
    ],
    cloudflare: { zoneId: '__ZONE__', apiToken: '__TOKEN__', apiBase: opts.apiBase },
  }
  const source = `export default ${JSON.stringify({ ...repoConfig, security }, null, 2)}\n`
    .replace('"__ZONE__"', "process.env['CLOUDFLARE_ZONE_ID']")
    .replace('"__TOKEN__"', "process.env['CLOUDFLARE_API_TOKEN']")
  writeFileSync(join(dir, 'nymbal.config.ts'), source)
  const resolved = {
    ...security,
    cloudflare: { zoneId: opts.zoneId, apiToken: opts.token, apiBase: opts.apiBase },
  }
  return {
    dir,
    env: cliEnv({ CLOUDFLARE_ZONE_ID: opts.zoneId, CLOUDFLARE_API_TOKEN: opts.token }),
    security: resolved,
  }
}

function zone(plan: Plan, token: string): string {
  return fake.addZone({ plan, token })
}

const cli = (p: Project, args: readonly string[]): Promise<CliRun> =>
  runCli([...args], { cwd: p.dir, env: p.env })

function parsePlan(stdout: string): SpecPlan {
  return JSON.parse(stdout) as SpecPlan
}

const planIsEmpty = (plan: SpecPlan): boolean =>
  plan.phases.every((p) => p.add.length + p.change.length + p.remove.length === 0)

describe('AC-7: nymbal security:*', () => {
  it('AC-7: security:plan --json prints a SecurityPlan adding exactly the rules desiredRules gives; security:apply exits 0; a second plan --json prints an empty plan', async () => {
    const token = 'cf-cli-token-Hq7Zt2'
    const p = project({ apiBase: fake.url, zoneId: zone('pro', token), token })

    const first = await cli(p, ['security:plan', '--json'])
    expect(first.code, first.out).toBe(0)
    const plan = parsePlan(first.stdout)
    const { desiredRules } = (await import('../../../security-cloudflare/src/index.js')) as {
      desiredRules(config: unknown): Record<string, Array<{ ref?: string }>>
    }
    const wanted = Object.values(desiredRules(p.security))
      .flat()
      .map((r) => String(r.ref))
      .sort()
    expect(plan.phases.flatMap((ph) => ph.add.map((r) => String(r.ref))).sort()).toEqual(wanted)
    expect(plan.phases.flatMap((ph) => [...ph.change, ...ph.remove])).toEqual([])

    const apply = await cli(p, ['security:apply'])
    expect(apply.code, apply.out).toBe(0)

    const second = await cli(p, ['security:plan', '--json'])
    expect(second.code, second.out).toBe(0)
    expect(planIsEmpty(parsePlan(second.stdout))).toBe(true)
  }, 60_000)

  it('AC-7: after apply, security:drift exits 0; after a dashboard edit it exits 1 and names the path; with the API answering 401 it exits 2 naming CLOUDFLARE_API_TOKEN', async () => {
    const token = 'cf-cli-token-Rw3Lp9'
    const zoneId = zone('pro', token)
    const p = project({ apiBase: fake.url, zoneId, token })
    const applied = await cli(p, ['security:apply'])
    expect(applied.code, applied.out).toBe(0)

    const inSync = await cli(p, ['security:drift'])
    expect(inSync.code, inSync.out).toBe(0)

    fake.edit(zoneId, CUSTOM, GEO, { expression: '(ip.src.country in {"FR"})' })
    const drifted = await cli(p, ['security:drift'])
    expect(drifted.code, drifted.out).toBe(1)
    expect(drifted.out).toContain(`${CUSTOM}/${GEO}/expression`)

    const wrong = project({ apiBase: fake.url, zoneId, token: 'cf-revoked-Kd82Mx' })
    const refused = await cli(wrong, ['security:drift'])
    expect(refused.code, refused.out).toBe(2)
    expect(refused.out).toContain('CLOUDFLARE_API_TOKEN')
    expect([inSync.code, drifted.code, refused.code]).toEqual([0, 1, 2])
  }, 60_000)

  it('AC-7: with security.adapter middleware, every command exits 2', async () => {
    const token = 'cf-cli-token-Mw5Nb1'
    const p = project({
      apiBase: fake.url,
      zoneId: zone('pro', token),
      token,
      adapter: 'middleware',
    })
    const runs = await Promise.all(COMMANDS.map((args) => cli(p, args)))
    expect(runs.map((r) => r.code)).toEqual(COMMANDS.map(() => 2))
    expect(
      fake.writes().filter((w) => w.path.includes(String(p.env['CLOUDFLARE_ZONE_ID']))),
    ).toEqual([])
  }, 60_000)

  it('AC-7: no command prints a distinctive token in stdout or stderr, whether it succeeds, is refused (401), cannot reach the API or fails validation', async () => {
    // 40 characters of the token alphabet, unlike anything the CLI prints on its own.
    const token = 'cf-Tok_Zq81Hv-Wm4Ps7Nx2Lb9Rc5Ty3Ka6Jd0Fg'
    const dead = `http://127.0.0.1:${await closedPort()}/client/v4`
    const outcomes = [
      project({ apiBase: fake.url, zoneId: zone('pro', token), token }),
      project({ apiBase: fake.url, zoneId: zone('pro', `${token}-other`), token }),
      project({ apiBase: dead, zoneId: zone('pro', token), token }),
      project({
        apiBase: fake.url,
        zoneId: zone('free', token),
        token,
        rateLimit: {
          '/api/auth/login': { requests: 10, window: '1m', action: 'throttle' },
          '/api/auth/register': { requests: 10, window: '1m', action: 'block' },
        },
      }),
    ]
    const runs = await Promise.all(outcomes.flatMap((p) => COMMANDS.map((args) => cli(p, args))))
    expect(runs).toHaveLength(outcomes.length * COMMANDS.length)
    expect(runs.filter((run) => `${run.stdout}\n${run.stderr}`.includes(token))).toEqual([])
    // Each outcome really happened: the refused and unreachable projects never exit 0, and the invalid one's apply
    // is refused as a config error.
    const n = COMMANDS.length
    expect(runs.slice(n, 3 * n).filter((r) => r.code === 0)).toEqual([])
    expect(runs[3 * n + COMMANDS.findIndex(([c]) => c === 'security:apply')]?.code).toBe(2)
  }, 60_000)
})
