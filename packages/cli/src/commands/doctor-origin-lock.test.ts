import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conventionPackage, nymbalConfigSchema, resolveOriginLock } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import repoConfig from '../../../../nymbal.config.js'
import {
  startFakeCloudflare,
  type FakeCloudflare,
} from '../../../adapters/security/cloudflare/src/tests/fake-cloudflare.js'
import {
  cliEnv,
  doctorJson,
  migratedSqlite,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'
import { install, workspace } from '../../../../tests/support/project.js'

// `nymbal doctor` has an `origin lock` line after `trust proxy`. With NYMBAL_ORIGIN_SECRET set on a Cloudflare store it
// asks the zone whether it sends an entry of the secret under the lock header: a zone that sends none (its rule was
// deleted, or holds another value) is the lockout, every request refused, and the line is down naming both ways out.
// Without the secret a Cloudflare store answers requests that skip the CDN, which is a warning. No detail holds a
// secret. Each project's node_modules holds the Cloudflare package; the zone is a fake. Spawns the built CLI.

const VAR = 'NYMBAL_ORIGIN_SECRET'
const TOKEN = 'cf-doctor-origin-token-5Hs2Kq'
const TRANSFORM = 'http_request_late_transform' as const
const REF = 'nymbal:origin-lock'
const S = 'doctor-origin-secret-Qm4Xv8Lp2Rt6Zw0KaBc'
const OTHER = 'doctor-other-secret-Wm4Ps7Nx2Lb9Rc5Ty3'

let dir = ''
let fake: FakeCloudflare
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-origin-'))
  fake = await startFakeCloudflare()
})
afterAll(async () => {
  await fake.close()
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

const lockRule = (value: string) => ({
  ref: REF,
  description: 'nymbal: origin lock',
  expression: 'true',
  action: 'rewrite',
  action_parameters: { headers: { 'X-Nymbal-Origin': { operation: 'set', value } } },
  enabled: true,
})

/** A zone sending `value` under X-Nymbal-Origin, or with no rule when undefined. */
function zoneSending(value: string | undefined): string {
  return fake.addZone({
    plan: 'pro',
    token: TOKEN,
    ...(value !== undefined && { phases: { [TRANSFORM]: [lockRule(value)] } }),
  })
}

function rawConfig(security: Record<string, unknown>) {
  return {
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { ...repoConfig.security, ...security },
  }
}

const cloudflare = (zoneId: string, apiToken = TOKEN) => ({
  adapter: 'cloudflare',
  cloudflare: { zoneId, apiToken, apiBase: fake.url },
})

async function doctor(security: Record<string, unknown>, secret?: string): Promise<CliRun> {
  const project = mkdtempSync(join(dir, 'project-'))
  install(project, workspace(conventionPackage('security', 'cloudflare')))
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(rawConfig(security), null, 2)}\n`,
  )
  const sqlitePath = join(project, 'nymbal.db')
  await migratedSqlite(sqlitePath)
  const env = cliEnv({
    NYMBAL_SQLITE_PATH: sqlitePath,
    [VAR]: secret,
    NYMBAL_TRUSTED_PROXIES: undefined,
    NYMBAL_CLIENT_IP_HEADER: undefined,
  })
  return runCli(['doctor', '--json'], { cwd: project, env })
}

const checks = (run: CliRun) => doctorJson(run.stdout).checks
const lineOf = (run: CliRun, name: string) => checks(run).find((c) => c.name === name)

describe('AC-12: doctor sees the lockout', () => {
  it('AC-12: a cloudflare store without the secret is degraded naming NYMBAL_ORIGIN_SECRET, nymbal security:apply and nymbal deploy nginx, on the line right after trust proxy, and doctor exits 0; with the secret set and the zone sending it the line is ok naming X-Nymbal-Origin', async () => {
    const unset = await doctor(cloudflare(zoneSending(undefined)))
    const held = await doctor(cloudflare(zoneSending(S)), S)
    const names = checks(unset).map((c) => c.name)

    expect(unset.code, unset.out.slice(-3000)).toBe(0)
    expect(names.indexOf('origin lock')).toBe(names.indexOf('trust proxy') + 1)
    expect(lineOf(unset, 'origin lock')?.status).toBe('degraded')
    for (const named of [VAR, 'nymbal security:apply', 'nymbal deploy nginx']) {
      expect(lineOf(unset, 'origin lock')?.detail).toContain(named)
    }
    expect([held.code, lineOf(held, 'origin lock')?.status], held.out.slice(-3000)).toEqual([
      0,
      'ok',
    ])
    expect(lineOf(held, 'origin lock')?.detail).toContain('X-Nymbal-Origin')
  }, 120_000)

  it('AC-12: with the secret set, a zone whose rule was deleted, or which sends another value, is down naming nymbal security:apply and unsetting NYMBAL_ORIGIN_SECRET, and doctor exits 1; a zone refusing the token is degraded beside slot security down', async () => {
    const deletedZone = zoneSending(S)
    fake.remove(deletedZone, TRANSFORM, REF)
    const deleted = await doctor(cloudflare(deletedZone), S)
    const other = await doctor(cloudflare(zoneSending(OTHER)), S)
    const refused = await doctor(cloudflare(zoneSending(S), 'cf-revoked-origin-token'), S)

    expect([deleted.code, other.code]).toEqual([1, 1])
    for (const run of [deleted, other]) {
      const line = lineOf(run, 'origin lock')
      expect(line?.status, run.out.slice(-3000)).toBe('down')
      expect(line?.detail).toContain('nymbal security:apply')
      expect(line?.detail).toContain(`unset ${VAR}`)
    }
    expect([
      lineOf(refused, 'origin lock')?.status,
      lineOf(refused, 'slot security')?.status,
    ]).toEqual(['degraded', 'down'])
  }, 120_000)

  it("AC-12: a malformed secret is down with resolveOriginLock's message; on middleware a set secret is ok saying the CDN must send the header, and an unset one is ok and off; no detail holds a secret", async () => {
    const malformedValue = 'malformed origin secret Ln6Vb1Xc4Md'
    const parsed = nymbalConfigSchema.parse(rawConfig({ adapter: 'middleware' }))
    let refusal = ''
    try {
      resolveOriginLock(parsed, { [VAR]: malformedValue })
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      refusal = error.message
    }
    const malformed = await doctor(cloudflare(zoneSending(S)), malformedValue)
    const middlewareOn = await doctor({ adapter: 'middleware' }, S)
    const middlewareOff = await doctor({ adapter: 'middleware' })

    expect(refusal).not.toBe('')
    expect(lineOf(malformed, 'origin lock')?.status).toBe('down')
    expect(lineOf(malformed, 'origin lock')?.detail).toContain(refusal)
    expect([middlewareOn.code, middlewareOff.code]).toEqual([0, 0])
    expect(lineOf(middlewareOn, 'origin lock')?.status).toBe('ok')
    expect(lineOf(middlewareOn, 'origin lock')?.detail).toContain('X-Nymbal-Origin')
    expect(lineOf(middlewareOff, 'origin lock')).toEqual({
      name: 'origin lock',
      status: 'ok',
      detail: expect.stringMatching(/\boff\b/),
    })
    expect(
      [malformed, middlewareOn, middlewareOff]
        .flatMap(checks)
        .filter((c) => [S, malformedValue].some((secret) => c.detail.includes(secret))),
    ).toEqual([])
  }, 120_000)
})
