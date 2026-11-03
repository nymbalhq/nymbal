import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import { resolveTrustProxy } from '@nymbalhq/http'
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

// doctor reads the proxy hop count the server would resolve and says, before the first shopper arrives, when every
// shopper would share one rate-limit bucket: no hop trusted while the store has a public, non-loopback origin. Trusting
// every hop is a warning too; a hop count the server refuses is down. Spawns the built CLI (`pnpm build` first).

const VARIABLE = 'NYMBAL_TRUST_PROXY_HOPS'
const PUBLIC = 'https://shop.example'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-trust-proxy-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** The project config with `http.trustProxy` as given (absent when undefined), on the default stores. */
function rawConfig(trustProxy: boolean | number | undefined) {
  return {
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    http: trustProxy === undefined ? { ...repoConfig.http } : { ...repoConfig.http, trustProxy },
  }
}

interface Case {
  trustProxy?: boolean | number
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
    `export default ${JSON.stringify(rawConfig(c.trustProxy), null, 2)}\n`,
  )
  const sqlitePath = join(project, 'nymbal.db')
  await migratedSqlite(sqlitePath)
  const env = cliEnv({
    NYMBAL_SQLITE_PATH: sqlitePath,
    NODE_ENV: undefined,
    [VARIABLE]: c.hops,
    NYMBAL_PUBLIC_URL: c.publicUrl,
  })
  return runCli(json ? ['doctor', '--json'] : ['doctor'], { cwd: project, env })
}

const trustProxyCheck = (run: CliRun) =>
  doctorJson(run.stdout).checks.find((check) => check.name === 'trust proxy')

describe('AC-6: nymbal doctor reports the trust proxy setting', () => {
  it(`AC-6: the default config, ${VARIABLE} unset and NYMBAL_PUBLIC_URL ${PUBLIC} is degraded naming ${VARIABLE}, printed as warn, and doctor exits 0`, async () => {
    const run = await doctor({ publicUrl: PUBLIC })
    const text = await doctor({ publicUrl: PUBLIC }, false)
    const check = trustProxyCheck(run)

    expect(check?.status, run.out.slice(-3000)).toBe('degraded')
    expect(check?.detail).toContain(VARIABLE)
    expect(run.code).toBe(0)
    expect(doctorLines(text.out).find((l) => l.name === 'trust proxy')?.status).toBe('warn')
    expect(text.code).toBe(0)
  }, 60_000)

  it(`AC-6: ${VARIABLE}=1 is ok naming 1 hop, with the same public URL`, async () => {
    const run = await doctor({ hops: '1', publicUrl: PUBLIC })
    const check = trustProxyCheck(run)

    expect(check?.status, run.out.slice(-3000)).toBe('ok')
    expect(check?.detail).toMatch(/\b1 hop\b/)
    expect(run.code).toBe(0)
    // The count doctor names is the one the server resolves from the same config and variable.
    expect(Number.parseInt(check?.detail ?? '', 10)).toBe(
      resolveTrustProxy(nymbalConfigSchema.parse(rawConfig(undefined)), { [VARIABLE]: '1' }),
    )
  }, 60_000)

  it('AC-6: http.trustProxy true is degraded naming the hop count, and doctor exits 0', async () => {
    const run = await doctor({ trustProxy: true, publicUrl: PUBLIC })
    const check = trustProxyCheck(run)

    expect(check?.status, run.out.slice(-3000)).toBe('degraded')
    expect(check?.detail).toMatch(/hop count/)
    expect(run.code).toBe(0)
  }, 60_000)

  it(`AC-6: ${VARIABLE}=x is down with the server's own ConfigError message, the only down check, and doctor exits 1`, async () => {
    const run = await doctor({ hops: 'x', publicUrl: PUBLIC })
    const check = trustProxyCheck(run)
    let refusal = ''
    try {
      resolveTrustProxy(nymbalConfigSchema.parse(rawConfig(undefined)), { [VARIABLE]: 'x' })
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      refusal = error.message
    }

    expect(refusal).toContain(VARIABLE)
    expect(check?.status, run.out.slice(-3000)).toBe('down')
    expect(check?.detail).toBe(refusal)
    expect(
      doctorJson(run.stdout)
        .checks.filter((c) => c.status === 'down')
        .map((c) => c.name),
    ).toEqual(['trust proxy'])
    expect(run.code).toBe(1)
  }, 60_000)

  it('AC-6: with no hop set, an unset or loopback public URL is ok', async () => {
    const runs = [
      await doctor({}),
      await doctor({ publicUrl: 'http://localhost:4321' }),
      await doctor({ publicUrl: 'http://127.0.0.1:3001' }),
    ]

    expect(runs.map((run) => trustProxyCheck(run)?.status)).toEqual(['ok', 'ok', 'ok'])
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0])
  }, 90_000)

  it(`AC-6: an explicit 0, from ${VARIABLE}=0 or http.trustProxy 0, is ok naming 0 hops with a public URL`, async () => {
    const runs = [
      await doctor({ hops: '0', publicUrl: PUBLIC }),
      await doctor({ trustProxy: 0, publicUrl: PUBLIC }),
    ]
    const checks = runs.map((run) => trustProxyCheck(run))

    expect(checks.map((check) => check?.status)).toEqual(['ok', 'ok'])
    expect(checks.map((check) => /\b0 hops\b/.test(check?.detail ?? ''))).toEqual([true, true])
    // The unset default with the same public URL is not ok: the explicit 0 is what clears it.
    expect(trustProxyCheck(await doctor({ publicUrl: PUBLIC }))?.status).not.toBe(checks[0]?.status)
  }, 90_000)
})
