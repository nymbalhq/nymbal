import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import repoConfig from '../../../../nymbal.config.js'
import {
  cliEnv,
  doctorJson,
  migratedSqlite,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'

// `nymbal doctor --json` carries the access token lifetime line beside its other checks: degraded for an accessTtl over
// 15 minutes on an https store, ok on an http one. Spawns the built CLI (`pnpm build` first) in a fresh project per case,
// on the repository's config.

const NAME = 'access token lifetime'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-access-ttl-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** `nymbal doctor --json` in a fresh project on the repository's config, with this store URL and accessTtl. */
async function doctor(storeUrl: string, accessTtl: string): Promise<CliRun> {
  const project = mkdtempSync(join(dir, 'project-'))
  const raw = {
    ...repoConfig,
    store: { ...repoConfig.store, url: storeUrl },
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { ...repoConfig.security, auth: { accessTtl, refreshTtl: '7d' } },
  }
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'test-store', private: true, type: 'module' })}\n`,
  )
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
  })
  return runCli(['doctor', '--json'], { cwd: project, env })
}

const lineOf = (run: CliRun) => doctorJson(run.stdout).checks.find((c) => c.name === NAME)

describe('AC-6: nymbal doctor --json carries the access token lifetime line', () => {
  it('AC-6: for accessTtl 16m the line is degraded on an https store and ok on an http one', async () => {
    const https = await doctor('https://shop.example', '16m')
    const http = await doctor('http://localhost:4321', '16m')

    expect([lineOf(https)?.status, lineOf(http)?.status], https.out.slice(-2000)).toEqual([
      'degraded',
      'ok',
    ])
    // The two projects differ only in the store's URL, and so do their lines.
    expect(lineOf(https)?.detail).not.toBe(lineOf(http)?.detail)
  }, 60_000)
})
