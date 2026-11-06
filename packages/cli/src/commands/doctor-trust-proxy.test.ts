import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, resolveTrustedProxies } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import repoConfig from '../../../../nymbal.config.js'
import {
  cliEnv,
  doctorJson,
  doctorLines,
  migratedSqlite,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'

// doctor reads the trusted proxy list the server would resolve, and where it came from, and says before the first
// shopper arrives when every shopper would share one rate-limit bucket: the list left at its default while the store
// has a public, non-loopback origin. Stating any list clears it; a list or setting the server refuses is down, with
// the server's own message. Spawns the built CLI (`pnpm build` first).

const LIST_VAR = 'NYMBAL_TRUSTED_PROXIES'
const HEADER_VAR = 'NYMBAL_CLIENT_IP_HEADER'
const HOPS_VAR = 'NYMBAL_TRUST_PROXY_HOPS'
const PUBLIC = 'https://shop.example'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-trust-proxy-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** The project config with `http.trustedProxies` as given (absent when undefined), on the default stores. */
function rawConfig(trustedProxies?: string[]) {
  const http = repoConfig.http
  return {
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    http: trustedProxies === undefined ? http : { ...http, trustedProxies },
  }
}

interface Case {
  trustedProxies?: string[]
  list?: string
  header?: string
  hops?: string
  publicUrl?: string
}

/** `nymbal doctor --json` (or the text form) in a fresh project for the case; NODE_ENV is unset in the child. */
async function doctor(c: Case, json = true): Promise<CliRun> {
  const project = mkdtempSync(join(dir, 'project-'))
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'test-store', private: true, type: 'module' })}\n`,
  )
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(rawConfig(c.trustedProxies), null, 2)}\n`,
  )
  const sqlitePath = join(project, 'nymbal.db')
  await migratedSqlite(sqlitePath)
  const env = cliEnv({
    NYMBAL_SQLITE_PATH: sqlitePath,
    NODE_ENV: undefined,
    [LIST_VAR]: c.list,
    [HEADER_VAR]: c.header,
    [HOPS_VAR]: c.hops,
    NYMBAL_PUBLIC_URL: c.publicUrl,
  })
  return runCli(json ? ['doctor', '--json'] : ['doctor'], { cwd: project, env })
}

const trustProxyCheck = (run: CliRun) =>
  doctorJson(run.stdout).checks.find((check) => check.name === 'trust proxy')
const downNames = (run: CliRun) =>
  doctorJson(run.stdout)
    .checks.filter((check) => check.status === 'down')
    .map((check) => check.name)

/** The server's own refusal for this environment on the default config: its ConfigError message. */
function serverRefusal(env: NodeJS.ProcessEnv): string {
  try {
    resolveTrustedProxies(nymbalConfigSchema.parse(rawConfig()), env)
  } catch (error) {
    if (error instanceof ConfigError) return error.message
    throw error
  }
  return '(the server resolved it)'
}

describe('AC-8: nymbal doctor reports the trusted proxy list', () => {
  it(`AC-8: the default list with NYMBAL_PUBLIC_URL ${PUBLIC} is degraded naming ${LIST_VAR} and uniquelocal, printed as warn, and doctor exits 0`, async () => {
    const run = await doctor({ publicUrl: PUBLIC })
    const text = await doctor({ publicUrl: PUBLIC }, false)
    const check = trustProxyCheck(run)

    expect(check?.status, run.out.slice(-3000)).toBe('degraded')
    expect(check?.detail).toContain(LIST_VAR)
    expect(check?.detail).toContain('uniquelocal')
    expect(run.code).toBe(0)
    expect(doctorLines(text.out).find((l) => l.name === 'trust proxy')?.status).toBe('warn')
    expect(text.code).toBe(0)
  }, 60_000)

  it(`AC-8: ${LIST_VAR}=loopback with the same public URL is ok naming loopback from ${LIST_VAR}; http.trustedProxies ['uniquelocal'] is ok naming from http.trustedProxies`, async () => {
    const fromEnv = trustProxyCheck(await doctor({ list: 'loopback', publicUrl: PUBLIC }))
    const fromConfig = trustProxyCheck(
      await doctor({ trustedProxies: ['uniquelocal'], publicUrl: PUBLIC }),
    )
    const unstated = trustProxyCheck(await doctor({ publicUrl: PUBLIC }))

    expect([fromEnv?.status, fromConfig?.status]).toEqual(['ok', 'ok'])
    expect(fromEnv?.detail).toContain(`loopback from ${LIST_VAR}`)
    expect(fromConfig?.detail).toContain('uniquelocal from http.trustedProxies')
    // The same public URL with the list unstated is not ok: stating the list is what clears it.
    expect(unstated?.status).not.toBe(fromEnv?.status)
  }, 90_000)

  it('AC-8: the default list with no public URL, or a loopback one, is ok', async () => {
    const runs = [
      await doctor({}),
      await doctor({ publicUrl: 'http://localhost:4321' }),
      await doctor({ publicUrl: 'http://127.0.0.1:3001' }),
    ]

    expect(runs.map((run) => trustProxyCheck(run)?.status)).toEqual(['ok', 'ok', 'ok'])
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0])
  }, 90_000)

  it(`AC-8: ${LIST_VAR}=10.0.0.0/33 is down with resolveTrustedProxies' own message, the only down check, and doctor exits 1`, async () => {
    const run = await doctor({ list: '10.0.0.0/33', publicUrl: PUBLIC })
    const refusal = serverRefusal({ [LIST_VAR]: '10.0.0.0/33' })

    expect(refusal).toContain('10.0.0.0/33')
    expect(trustProxyCheck(run)?.status, run.out.slice(-3000)).toBe('down')
    expect(trustProxyCheck(run)?.detail).toBe(refusal)
    expect(downNames(run)).toEqual(['trust proxy'])
    expect(run.code).toBe(1)
  }, 60_000)

  it(`AC-8: ${HOPS_VAR}=1 is down naming ${LIST_VAR}, and ${LIST_VAR}=0.0.0.0/0 is down with the trust-everyone refusal; doctor exits 1 for each`, async () => {
    const hops = await doctor({ hops: '1', publicUrl: PUBLIC })
    const everyone = await doctor({ list: '0.0.0.0/0' })

    expect(trustProxyCheck(hops)?.status, hops.out.slice(-3000)).toBe('down')
    expect(trustProxyCheck(hops)?.detail).toContain(LIST_VAR)
    expect(trustProxyCheck(hops)?.detail).toBe(serverRefusal({ [HOPS_VAR]: '1' }))
    expect(trustProxyCheck(everyone)?.status).toBe('down')
    expect(trustProxyCheck(everyone)?.detail).toBe(serverRefusal({ [LIST_VAR]: '0.0.0.0/0' }))
    expect([downNames(hops), downNames(everyone)]).toEqual([['trust proxy'], ['trust proxy']])
    expect([hops.code, everyone.code]).toEqual([1, 1])
  }, 90_000)

  it(`AC-8: ${HEADER_VAR}=True-Client-IP is ok naming the header`, async () => {
    const run = await doctor({ header: 'True-Client-IP' })
    const without = await doctor({})
    const check = trustProxyCheck(run)

    expect(check?.status, run.out.slice(-3000)).toBe('ok')
    expect(check?.detail.toLowerCase()).toContain('true-client-ip')
    expect(trustProxyCheck(without)?.detail.toLowerCase()).not.toContain('true-client-ip')
  }, 90_000)
})
