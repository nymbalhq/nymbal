import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conventionPackage } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import { installLine } from '../../../platform/src/adapters/index.js'
import {
  startFakeCloudflare,
  type FakeCloudflare,
} from '../../../adapters/security/cloudflare/src/tests/fake-cloudflare.js'
import {
  cliEnv,
  doctorLines,
  migratedSqlite,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'

// doctor checks the security slot as it checks a commerce slot, against a fake Cloudflare API: a refused token or a
// missing package is down and exits 1. Spawns the built CLI (`pnpm build` first).

const TOKEN = 'cf-doctor-token-accepted-3Rk9'
const SECURITY_PACKAGE = conventionPackage('security', 'cloudflare')

let dir = ''
let fake: FakeCloudflare
let zoneId = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-security-'))
  fake = await startFakeCloudflare()
  zoneId = fake.addZone({ plan: 'pro', token: TOKEN })
})

afterAll(async () => {
  await fake.close()
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/**
 * NODE_OPTIONS for a child in which each of `specifiers` resolves as if imported from an empty directory under `dir`
 * (no node_modules above it), so Node raises the error it raises for a package that is not installed.
 */
function hiding(specifiers: string[]): string {
  const nowhere = mkdtempSync(join(dir, 'nowhere-'))
  const hooks = join(nowhere, 'hide-hooks.mjs')
  const entry = join(nowhere, 'hide-register.mjs')
  writeFileSync(
    hooks,
    [
      `const hide = ${JSON.stringify(specifiers)}`,
      `const parentURL = ${JSON.stringify(pathToFileURL(join(nowhere, 'x.mjs')).href)}`,
      'export async function resolve(specifier, context, nextResolve) {',
      '  if (hide.includes(specifier)) return nextResolve(specifier, { ...context, parentURL })',
      '  return nextResolve(specifier, context)',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    entry,
    `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hooks).href)})\n`,
  )
  return `--import=${pathToFileURL(entry).href}`
}

/** Runs `nymbal doctor` in a fresh project whose config has `security` replaced by `security`. */
async function doctor(
  security: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<CliRun & { project: string; env: NodeJS.ProcessEnv }> {
  const project = mkdtempSync(join(dir, 'project-'))
  const raw = {
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { ...repoConfig.security, ...security },
  }
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(raw, null, 2)}\n`,
  )
  const sqlitePath = join(project, 'nymbal.db')
  await migratedSqlite(sqlitePath)
  const env = cliEnv({ NYMBAL_SQLITE_PATH: sqlitePath, ...extraEnv })
  return { ...(await runCli(['doctor'], { cwd: project, env })), project, env }
}

const line = (run: CliRun, name: string) => doctorLines(run.out).find((l) => l.name === name)
const cloudflare = (apiToken: string) => ({
  adapter: 'cloudflare',
  cloudflare: { zoneId, apiToken, apiBase: fake.url },
})

describe('nymbal doctor checks the security slot', () => {
  it('cloudflare with the token the zone accepts: `package security` and `slot security` are ok, naming the zone, and doctor exits 0', async () => {
    const run = await doctor(cloudflare(TOKEN))

    expect(run.code, run.out.slice(-3000)).toBe(0)
    expect(line(run, 'package security')?.status).toBe('ok')
    expect(line(run, 'slot security')?.status).toBe('ok')
    expect(line(run, 'slot security')?.detail).toContain(zoneId)
  }, 60_000)

  it('cloudflare with a token the zone refuses: `slot security` is down, doctor exits 1, and the token is not printed', async () => {
    const revoked = 'cf-doctor-token-revoked-8Lw2'
    const run = await doctor(cloudflare(revoked))
    const slot = line(run, 'slot security')

    expect(run.code, run.out.slice(-3000)).toBe(1)
    expect(slot?.status).toBe('down')
    expect(slot?.detail).toMatch(/^cloudflare/)
    expect(line(run, 'package security')?.status).toBe('ok')
    expect(
      doctorLines(run.out)
        .filter((l) => l.status === 'down')
        .map((l) => l.name),
    ).toEqual(['slot security'])
    expect(run.out).not.toContain(revoked)
  }, 60_000)

  it('cloudflare with @nymbalhq/security-cloudflare not installed: `package security` is down with the install line, `slot security` is down, and doctor exits 1', async () => {
    const run = await doctor(cloudflare(TOKEN), { NODE_OPTIONS: hiding([SECURITY_PACKAGE]) })
    const pkg = line(run, 'package security')

    expect(run.code, run.out.slice(-3000)).toBe(1)
    expect(pkg?.status).toBe('down')
    expect(pkg?.detail).toContain(installLine([SECURITY_PACKAGE], run.env, run.project))
    expect(line(run, 'slot security')?.status).toBe('down')
  }, 60_000)

  it('middleware: `slot security` is ok and there is no `package security` line', async () => {
    const requests = fake.requests.length
    const run = await doctor({ adapter: 'middleware' })

    expect(run.code, run.out.slice(-3000)).toBe(0)
    expect(line(run, 'slot security')).toEqual({
      status: 'ok',
      name: 'slot security',
      detail: expect.stringMatching(/^middleware/),
    })
    expect(line(run, 'package security')).toBeUndefined()
    expect(fake.requests.length).toBe(requests)
  }, 60_000)
})
