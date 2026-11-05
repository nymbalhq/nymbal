import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, resolveTrustedProxies } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import repoConfig from '../../../../nymbal.config.js'
import {
  cliEnv,
  doctorJson,
  migratedSqlite,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'
import { install } from '../../../../tests/support/project.js'

// A security adapter may offer the trusted proxy list and the client-address header at boot, below what the store
// sets and above the default. doctor reads that offer from the adapter it already builds for `slot security` and says
// where each value in effect came from; an offer it cannot read is unknown, never assumed empty. The adapter here is a
// test package installed into each project. Spawns the built CLI (`pnpm build` first).

const LIST_VAR = 'NYMBAL_TRUSTED_PROXIES'
const PACKAGE = '@acme/nymbal-security-edge'
const NAME = 'edge'
const FIXTURE = fileURLToPath(new URL('./fixtures/security-edge.mjs', import.meta.url))

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-network-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

interface Case {
  /** The edge adapter's `security.config`; the built-in middleware adapter when undefined. */
  edge?: { network?: Record<string, unknown>; mode?: string }
  http?: Record<string, unknown>
  env?: Record<string, string>
}

async function doctor(c: Case): Promise<CliRun> {
  const project = mkdtempSync(join(dir, 'project-'))
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'test-store', private: true, type: 'module' })}\n`,
  )
  install(project, { [PACKAGE]: FIXTURE })
  const raw = {
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security:
      c.edge === undefined
        ? { ...repoConfig.security, adapter: 'middleware' }
        : { ...repoConfig.security, adapter: NAME, package: PACKAGE, config: c.edge },
    http: { ...repoConfig.http, ...c.http },
  }
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(raw, null, 2)}\n`,
  )
  const sqlitePath = join(project, 'nymbal.db')
  await migratedSqlite(sqlitePath)
  const env = cliEnv({
    NYMBAL_SQLITE_PATH: sqlitePath,
    NODE_ENV: undefined,
    NYMBAL_PUBLIC_URL: undefined,
    [LIST_VAR]: undefined,
    NYMBAL_CLIENT_IP_HEADER: undefined,
    NYMBAL_TRUST_PROXY_HOPS: undefined,
    ...c.env,
  })
  return runCli(['doctor', '--json'], { cwd: project, env })
}

const check = (run: CliRun, name: string) =>
  doctorJson(run.stdout).checks.find((c) => c.name === name)

const OFFER = { clientIpHeader: 'X-Edge-Client', trustedProxies: ['10.0.0.0/8'] }

/** The server's own refusal of this contribution from the edge adapter, nothing else set: its ConfigError message. */
function serverRefusal(network: Record<string, unknown>): string {
  const config = nymbalConfigSchema.parse({
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
  })
  try {
    resolveTrustedProxies(config, {}, { adapter: NAME, network })
  } catch (error) {
    if (error instanceof ConfigError) return error.message
    throw error
  }
  return '(the server resolved it)'
}

describe('AC-16: doctor names the source of each network value, the adapter’s included', () => {
  it('AC-16: an adapter offering 10.0.0.0/8 and X-Edge-Client gives a trust proxy line naming each from adapter edge', async () => {
    const run = await doctor({ edge: { network: OFFER } })
    const line = check(run, 'trust proxy')

    expect(line?.status, run.out.slice(-3000)).toBe('ok')
    expect(line?.detail).toContain(`10.0.0.0/8 from adapter ${NAME}`)
    expect(line?.detail).toMatch(new RegExp(`x-edge-client from adapter ${NAME}`, 'i'))
  }, 60_000)

  it(`AC-16: with ${LIST_VAR}=loopback the list is loopback from ${LIST_VAR} and the header still from adapter edge; with http.clientIpHeader True-Client-IP the header is from http.clientIpHeader`, async () => {
    const listSet = check(
      await doctor({ edge: { network: OFFER }, env: { [LIST_VAR]: 'loopback' } }),
      'trust proxy',
    )
    const headerSet = check(
      await doctor({ edge: { network: OFFER }, http: { clientIpHeader: 'True-Client-IP' } }),
      'trust proxy',
    )

    expect(listSet?.detail).toContain(`loopback from ${LIST_VAR}`)
    expect(listSet?.detail).not.toContain('10.0.0.0/8')
    expect(listSet?.detail).toMatch(new RegExp(`x-edge-client from adapter ${NAME}`, 'i'))
    expect(headerSet?.detail).toMatch(/true-client-ip from http\.clientIpHeader/i)
    expect(headerSet?.detail).toContain(`10.0.0.0/8 from adapter ${NAME}`)
    expect(headerSet?.detail.toLowerCase()).not.toContain('x-edge-client')
  }, 90_000)

  it('AC-16: with the built-in adapter and nothing set, loopback is the default and nothing is from an adapter', async () => {
    const line = check(await doctor({}), 'trust proxy')

    expect(line?.status).toBe('ok')
    expect(line?.detail).toMatch(/\bloopback\b[^;]{0,20}\bdefault\b/)
    expect(line?.detail).not.toContain('from adapter')
  }, 60_000)

  it("AC-16: an adapter offering trustedProxies ['loopbak'] makes the line down naming adapter edge, and doctor exits 1", async () => {
    const run = await doctor({ edge: { network: { trustedProxies: ['loopbak'] } } })
    const line = check(run, 'trust proxy')

    expect(line?.status, run.out.slice(-3000)).toBe('down')
    expect(line?.detail).toContain(`adapter ${NAME}`)
    expect(line?.detail).toContain('loopbak')
    expect(run.code).toBe(1)
    expect(line?.detail).toBe(serverRefusal({ trustedProxies: ['loopbak'] }))
  }, 60_000)

  it('AC-16: an adapter that fails to build, or whose network() throws, leaves its offer unknown: the line says so and is degraded, beside slot security down for the failed build', async () => {
    const failedBuild = await doctor({ edge: { mode: 'fail-build', network: OFFER } })
    const throwing = await doctor({ edge: { mode: 'network-throws', network: OFFER } })
    const lines = [failedBuild, throwing].map((run) => check(run, 'trust proxy'))

    expect(
      lines.map((l) => l?.status),
      failedBuild.out.slice(-3000),
    ).toEqual(['degraded', 'degraded'])
    expect(lines.map((l) => /unknown/i.test(l?.detail ?? ''))).toEqual([true, true])
    expect(lines.map((l) => l?.detail.includes('10.0.0.0/8'))).toEqual([false, false])
    expect(check(failedBuild, 'slot security')?.status).toBe('down')
  }, 90_000)
})
