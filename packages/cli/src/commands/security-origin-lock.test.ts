import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import repoConfig from '../../../../nymbal.config.js'
import { cliEnv, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { install, workspace } from '../../../../tests/support/project.js'
import {
  startFakeCloudflare,
  type FakeCloudflare,
} from '../../../adapters/security/cloudflare/src/tests/fake-cloudflare.js'
import type { SpecPlan } from '../../../adapters/security/cloudflare/src/tests/support.js'

// `nymbal security:apply` against a fake Cloudflare API, on a store with no NYMBAL_ORIGIN_SECRET: it makes one, writes
// the origin-lock rule with it, and only once the zone holds the rule puts it in the project's .env (so a deploy that
// copies it from .env never sets a secret the edge does not send), then prints the host's command, never the value. A
// zone that already sends another secret is a lock some other machine set: apply refuses to replace it unless told to
// adopt it (.env takes the zone's value) or to make a new one. Rotation, the public-URL check and the masking of every
// secret in every security command's output are here too. Spawns the built CLI (`pnpm build` first).

const VAR = 'NYMBAL_ORIGIN_SECRET'
const REF = 'nymbal:origin-lock'
const TRANSFORM = 'http_request_late_transform' as const
const HEADER = 'X-Nymbal-Origin'
const ADOPT = '--adopt-origin-secret'
const RENEW = '--new-origin-secret'
const GENERIC =
  "set NYMBAL_ORIGIN_SECRET in the API's environment to the value in .env, then restart"

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
  zoneId: string
  /** The built CLI in the project, with NYMBAL_ORIGIN_SECRET as given (unset when undefined). */
  cli(args: string[], secret?: string): Promise<CliRun>
}

let zones = 0
function project(
  opts: {
    zoneName?: string
    publicUrl?: string
    dotEnv?: string
    host?: 'fly' | 'railway'
  } = {},
): Project {
  zones += 1
  const token = `cf-origin-token-${zones}-Hq7Zt2Lw9Kd8`
  const zoneId = fake.addZone({
    plan: 'pro',
    token,
    name: opts.zoneName ?? 'shop.example',
  })
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-cf-origin-'))
  dirs.push(dir)
  install(dir, workspace('@nymbalhq/security-cloudflare'))
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'shop', private: true, type: 'module' }, null, 2)}\n`,
  )
  const security = {
    ...repoConfig.security,
    adapter: 'cloudflare',
    rateLimit: { '/api/auth/login': { requests: 10, window: '1m', action: 'block' } },
    botProtection: { mode: 'off', allowList: [] },
    geo: { block: ['RU'] },
    customRules: [],
    cloudflare: { zoneId: '__ZONE__', apiToken: '__TOKEN__', apiBase: fake.url },
  }
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify({ ...repoConfig, security }, null, 2)}\n`
      .replace('"__ZONE__"', "process.env['CLOUDFLARE_ZONE_ID']")
      .replace('"__TOKEN__"', "process.env['CLOUDFLARE_API_TOKEN']"),
  )
  if (opts.dotEnv !== undefined) writeFileSync(join(dir, '.env'), opts.dotEnv)
  if (opts.host === 'fly') writeFileSync(join(dir, 'fly.toml'), 'app = "shop"\n')
  if (opts.host === 'railway') writeFileSync(join(dir, 'railway.json'), '{}\n')
  return {
    dir,
    zoneId,
    cli: (args, secret) =>
      runCli(args, {
        cwd: dir,
        env: cliEnv({
          CLOUDFLARE_ZONE_ID: zoneId,
          CLOUDFLARE_API_TOKEN: token,
          [VAR]: secret,
          NYMBAL_PUBLIC_URL: opts.publicUrl ?? 'https://shop.example',
        }),
      }),
  }
}

/** The value the zone's origin-lock rule sends, or undefined. */
function zoneSends(zoneId: string): string | undefined {
  const rule = (fake.rules(zoneId, TRANSFORM) ?? []).find((r) => r.ref === REF)
  const headers = rule?.action_parameters?.['headers'] as
    | Record<string, { value?: string }>
    | undefined
  return headers?.[HEADER]?.value
}

const dotEnv = (p: Project): string | null =>
  existsSync(join(p.dir, '.env')) ? readFileSync(join(p.dir, '.env'), 'utf8') : null
const secretLines = (text: string | null): string[] =>
  (text ?? '').split('\n').filter((line) => line.startsWith(`${VAR}=`))
const otherLines = (text: string | null): string[] =>
  (text ?? '').split('\n').filter((line) => line.trim() !== '' && !line.startsWith(`${VAR}=`))
const writes = (p: Project): number => fake.writes(p.zoneId).length

describe('AC-11: security:apply creates the origin secret, rule first', () => {
  it('AC-11 (a): with the variable unset and no rule on the zone, apply exits 0, the zone sends a 43-character base64url V, .env gains exactly one NYMBAL_ORIGIN_SECRET=V line keeping every prior line (created 0600 when absent), V is in neither stream, and stdout names the Fly, Railway or generic host command', async () => {
    const generic = project()
    const fly = project({
      host: 'fly',
      dotEnv: '# store settings\nFOO=bar\nEXTRA_URL=https://x.example\n',
    })
    const railway = project({ host: 'railway', dotEnv: 'BAZ=qux' })
    const projects = [generic, fly, railway]
    const before = projects.map(dotEnv)

    const runs = await Promise.all(projects.map((p) => p.cli(['security:apply'])))
    const sent = projects.map((p) => zoneSends(p.zoneId))
    const after = projects.map(dotEnv)

    expect(
      runs.map((r) => r.code),
      runs[0]!.out.slice(-2000),
    ).toEqual([0, 0, 0])
    expect(sent.map((v) => /^[A-Za-z0-9_-]{43}$/.test(v ?? ''))).toEqual([true, true, true])
    expect(after.map(secretLines)).toEqual(sent.map((v) => [`${VAR}=${v}`]))
    expect(after.map(otherLines)).toEqual(before.map(otherLines))
    expect(statSync(join(generic.dir, '.env')).mode & 0o777).toBe(0o600)
    expect(runs.filter((r, i) => r.out.includes(sent[i]!))).toEqual([])
    expect(runs[0]!.stdout).toContain(GENERIC)
    expect(runs[1]!.stdout).toContain(`flyctl secrets set ${VAR}=<from .env> --app shop`)
    expect(runs[2]!.stdout).toContain(`railway variables --service shop --set ${VAR}=<from .env>`)
  }, 120_000)

  it('AC-11 (b): a second apply makes zero writes and leaves .env byte-identical', async () => {
    const p = project()
    const first = await p.cli(['security:apply'])
    const env = dotEnv(p)
    const count = writes(p)

    const second = await p.cli(['security:apply'])

    expect([first.code, second.code], second.out).toEqual([0, 0])
    expect(secretLines(env)).toEqual([`${VAR}=${zoneSends(p.zoneId)}`])
    expect(writes(p)).toBe(count)
    expect(dotEnv(p)).toBe(env)
  }, 60_000)

  it('AC-11 (c): when the zone refuses the transform phase’s write, apply exits 2 and .env gets no NYMBAL_ORIGIN_SECRET', async () => {
    const p = project({ dotEnv: 'FOO=bar\n' })
    fake.refuseWrites(p.zoneId, TRANSFORM, 400)

    const run = await p.cli(['security:apply'])

    expect(run.code, run.out).toBe(2)
    expect(zoneSends(p.zoneId)).toBeUndefined()
    expect(secretLines(dotEnv(p))).toEqual([])
  }, 60_000)
})

describe('AC-11: apply never replaces a lock another machine set', () => {
  it(`AC-11 (d): over a zone sending W, apply with the variable unset or another secret exits 2 naming ${VAR}, ${REF}, ${ADOPT} then ${RENEW}, writing nothing; ${ADOPT} writes W into .env with no zone write and a following apply writes nothing; ${RENEW} sends a fresh secret, replaces the .env line and warns about the host; both flags together exit 2 writing nothing`, async () => {
    const W = 'other-machine-origin-secret-Kd8Mx3Pb5Vr4Ns'
    const p = project({ dotEnv: 'FOO=bar\n' })
    const setup = await p.cli(['security:apply'], W)
    expect([setup.code, zoneSends(p.zoneId)], setup.out).toEqual([0, W])
    const envBefore = dotEnv(p)
    const count = writes(p)

    const refusals = [
      await p.cli(['security:apply']),
      await p.cli(['security:apply'], 'this-machine-origin-secret-Gk1JcQm4Xv8L'),
    ]
    const order = (run: CliRun) => [VAR, REF, ADOPT, RENEW].map((word) => run.out.indexOf(word))
    expect(refusals.map((r) => r.code)).toEqual([2, 2])
    for (const run of refusals) {
      const at = order(run)
      expect(Math.min(...at), run.out).toBeGreaterThanOrEqual(0)
      expect(at).toEqual([...at].sort((a, b) => a - b))
    }
    expect([writes(p), dotEnv(p)]).toEqual([count, envBefore])

    const both = await p.cli(['security:apply', ADOPT, RENEW])
    expect([both.code, writes(p), dotEnv(p)]).toEqual([2, count, envBefore])

    const adopt = await p.cli(['security:apply', ADOPT])
    const adopted = dotEnv(p)
    const plain = await p.cli(['security:apply'])
    expect([adopt.code, plain.code], adopt.out + plain.out).toEqual([0, 0])
    expect(writes(p)).toBe(count)
    expect(secretLines(adopted)).toEqual([`${VAR}=${W}`])
    expect(otherLines(adopted)).toEqual(otherLines(envBefore))
    expect([adopt, plain, ...refusals, both].filter((r) => r.out.includes(W))).toEqual([])

    const renew = await p.cli(['security:apply', RENEW])
    const fresh = zoneSends(p.zoneId)
    expect(renew.code, renew.out).toBe(0)
    expect(fresh === undefined || fresh === W).toBe(false)
    expect(secretLines(dotEnv(p))).toEqual([`${VAR}=${fresh}`])
    expect(renew.out.includes(fresh!) || renew.out.includes(W)).toBe(false)
    expect(
      renew.out.split('\n').filter((line) => line.includes(VAR) && /\bhost\b/i.test(line)).length,
    ).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it(`AC-11 (e): security:plan and plan --json with the variable unset over a zone holding the rule print the guard's line (${ADOPT}) and no removal of ${REF}, and create nothing`, async () => {
    const W = 'held-origin-secret-for-plan-Lb9Rc5Ty3Ka6'
    const p = project()
    const setup = await p.cli(['security:apply'], W)
    expect([setup.code, zoneSends(p.zoneId)], setup.out).toEqual([0, W])
    const count = writes(p)

    const text = await p.cli(['security:plan'])
    const json = await p.cli(['security:plan', '--json'])
    const plan = JSON.parse(json.stdout) as SpecPlan
    const transform = plan.phases.find((ph) => ph.phase === TRANSFORM)

    expect([text.code, json.code], text.out + json.out).toEqual([0, 0])
    expect(text.out).toContain(ADOPT)
    expect(json.stderr).toContain(ADOPT)
    expect(text.out.split('\n').filter((line) => line.includes(REF) && /^\s*-/.test(line))).toEqual(
      [],
    )
    expect(
      [...(transform?.add ?? []), ...(transform?.remove ?? []), ...(transform?.change ?? [])]
        .length,
    ).toBe(0)
    expect([writes(p), dotEnv(p)]).toEqual([count, null])
  }, 60_000)

  it(`AC-11 (e): security:drift and drift --json with the variable unset over a zone holding the rule exit 0 with the guard's line (${ADOPT}) and no difference at ${REF}, as apply cannot restore one`, async () => {
    const W = 'held-origin-secret-for-drift-Pz3Nw8Qc1Hv5'
    const p = project()
    const setup = await p.cli(['security:apply'], W)
    expect([setup.code, zoneSends(p.zoneId)], setup.out).toEqual([0, W])
    const count = writes(p)

    const text = await p.cli(['security:drift'])
    const json = await p.cli(['security:drift', '--json'])
    const report = JSON.parse(json.stdout) as {
      drift: boolean
      differences: Array<{ path: string }>
    }

    expect([text.code, json.code], text.out + json.out).toEqual([0, 0])
    expect(text.stdout).toContain(ADOPT)
    expect(json.stderr).toContain(ADOPT)
    expect(text.out.split('\n').filter((line) => line.includes(`${TRANSFORM}/${REF}`))).toEqual([])
    expect([report.drift, report.differences.map((d) => d.path)]).toEqual([false, []])
    expect([writes(p), dotEnv(p)]).toEqual([count, null])
  }, 60_000)

  it('AC-11 (f): with the variable "N,S" over a zone sending S, apply exits 0, the zone sends N, and stdout says the host must already hold both; with "N" over a zone sending N there is no such line', async () => {
    const [N, S] = ['next-rotation-secret-Wm4Ps7Nx2Lb9Rc', 'current-rotation-secret-Ty3Ka6Jd0Fg']
    const p = project()
    const setup = await p.cli(['security:apply'], S)
    expect([setup.code, zoneSends(p.zoneId)], setup.out).toEqual([0, S])

    const rotating = await p.cli(['security:apply'], `${N},${S}`)
    const sentAfter = zoneSends(p.zoneId)
    const settled = await p.cli(['security:apply'], N)
    const bothLine = (run: CliRun) =>
      run.stdout.split('\n').filter((line) => line.includes(VAR) && /\bboth\b/i.test(line))

    expect([rotating.code, settled.code], rotating.out).toEqual([0, 0])
    expect(sentAfter).toBe(N)
    expect([bothLine(rotating).length, bothLine(settled).length]).toEqual([1, 0])
    expect([rotating, settled].filter((r) => r.out.includes(N) || r.out.includes(S))).toEqual([])
  }, 90_000)

  it('AC-11 (g): with NYMBAL_PUBLIC_URL https://shop.example, apply on a zone named other.example warns naming both and exits 0; on a zone named shop.example or example it does not', async () => {
    const zonesNamed = ['other.example', 'shop.example', 'example']
    const runs = await Promise.all(
      zonesNamed.map((zoneName) =>
        project({ zoneName, publicUrl: 'https://shop.example' }).cli(['security:apply']),
      ),
    )
    const naming = (run: CliRun, zoneName: string) =>
      run.out.split('\n').filter((line) => line.includes('shop.example') && line.includes(zoneName))

    expect(
      runs.map((r) => r.code),
      runs[0]!.out,
    ).toEqual([0, 0, 0])
    expect(naming(runs[0]!, 'other.example').length).toBeGreaterThanOrEqual(1)
    expect([runs[1]!, runs[2]!].map((r) => r.out.includes('shop.example'))).toEqual([false, false])
  }, 90_000)

  it('AC-11 (h): with the variable "A,B" over a zone sending W, security:plan, plan --json, drift, drift --json and inspect print neither A, B nor W', async () => {
    const W = 'zone-held-secret-never-printed-Xc4MdTz8Qw'
    const [A, B] = [
      'first-env-secret-never-printed-Ln6Vb1',
      'second-env-secret-never-printed-Rt6Zw0',
    ]
    const p = project()
    const setup = await p.cli(['security:apply'], W)
    expect([setup.code, zoneSends(p.zoneId)], setup.out).toEqual([0, W])

    const commands = [
      ['security:plan'],
      ['security:plan', '--json'],
      ['security:drift'],
      ['security:drift', '--json'],
      ['security:inspect'],
    ]
    const runs = await Promise.all(commands.map((args) => p.cli(args, `${A},${B}`)))

    expect(runs.map((r) => r.code).filter((code) => code === 0 || code === 1)).toHaveLength(
      commands.length,
    )
    expect(
      runs.filter((r) => [A, B, W].some((secret) => r.out.includes(secret))).map((r) => r.out),
    ).toEqual([])
    expect(runs[3]!.stdout).toContain(`${TRANSFORM}/${REF}`)
  }, 90_000)
})
