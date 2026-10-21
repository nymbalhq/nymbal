import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import { installLine, PROVIDER_PACKAGES } from '../../../platform/src/adapters/loader.js'
import {
  cliEnv,
  doctorLines,
  expectedCheckNames,
  migratedSqlite,
  onDefaultStores,
  REPO_ROOT,
  runCli,
  type CliRun,
  type DoctorLine,
} from '../../../../tests/support/doctor.js'

// Acceptance tests for P2-09 AC-5 (b) to (e) (spec P2-09-dev-stage, decision 4; Fable spec M3, M6): each failure
// exits 1 and has a `down` line naming its cause, and the other checks still run, with the same names as the healthy
// run of the same config; after a config failure only `config` appears.
// (b) a configured provider's package is not installed: `package payments` carries the loader's install line;
// (c) a database with 2 migrations unapplied: `migrations` names the count and `nymbal migrate`;
// (d) a missing SQLite file: `command store` is down, `migrations` is `down … not checked: command store down`, and the
//     file still does not exist afterwards;
// (e) a slot-rule violation (documentStore 'postgres-jsonb' on a SQLite command store): only `config`, carrying the
//     schema's own message.
// (a) needs a Redis package in the project's own node_modules and the composed Redis for its healthy run, so it runs
// on the scaffold in tests/stores/nymbal-add-redis.test.ts; (f) is in-process, in
// packages/platform/tests/integration/diagnose-no-healthcheck.test.ts.
// Kills: a failure that exits 0, the wrong check blamed, a dependent line dropped, a doctor that creates the database.
// Spawns the built CLI (`pnpm build` first).

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (path: string) => {
  prepare(sql: string): { run(): unknown; get(): unknown }
  close(): void
}

const PENDING = 2

let dir = ''
let healthy: CliRun

const repo = onDefaultStores(repoConfig)
const names = (lines: DoctorLine[]) => lines.map((l) => l.name)
const line = (run: CliRun, name: string) => doctorLines(run.out).find((l) => l.name === name)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-p2-09-doctor-fail-'))
  const sqlitePath = join(dir, 'healthy.db')
  await migratedSqlite(sqlitePath)
  healthy = await runCli(['doctor'], {
    cwd: REPO_ROOT,
    env: cliEnv({ NYMBAL_SQLITE_PATH: sqlitePath }),
  })
}, 120_000)

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe('P2-09 AC-5: each failure exits 1 and names its cause', () => {
  it('AC-5: the healthy baseline of the repository config exits 0 with every check listed', () => {
    expect(healthy.code, healthy.out.slice(-3000)).toBe(0)
    expect(names(doctorLines(healthy.out)).sort()).toEqual(expectedCheckNames(repo))
  })

  it('AC-5 (b): a provider whose package is not installed: `package payments` is down with the install line, and every other check still runs', async () => {
    const project = mkdtempSync(join(dir, 'no-stripe-'))
    const raw = {
      ...repoConfig,
      infrastructure: {
        commandStore: 'sqlite',
        documentStore: 'in-memory',
        eventBus: 'in-process',
      },
      commerce: {
        ...repoConfig.commerce,
        payments: { provider: 'stripe', config: { secretKey: 'sk_test_p209' } },
      },
    }
    writeFileSync(
      join(project, 'nymbal.config.ts'),
      `export default ${JSON.stringify(raw, null, 2)}\n`,
    )
    const sqlitePath = join(project, 'nymbal.db')
    await migratedSqlite(sqlitePath)
    const env = cliEnv({ NYMBAL_SQLITE_PATH: sqlitePath })
    const stripe = PROVIDER_PACKAGES.payments!['stripe']!

    const run = await runCli(['doctor'], { cwd: project, env })
    const pkg = line(run, 'package payments')

    expect(run.code, run.out.slice(-3000)).toBe(1)
    expect(pkg?.status).toBe('down')
    expect(pkg?.detail).toContain(installLine([stripe.package, stripe.sdk], env, project))
    expect(names(doctorLines(run.out)).sort()).toEqual(
      expectedCheckNames(nymbalConfigSchema.parse(raw)),
    )
  }, 60_000)

  it(`AC-5 (c): a database with ${PENDING} migrations unapplied: \`migrations\` is down naming ${PENDING} pending and \`nymbal migrate\`; the names are the healthy run's`, async () => {
    const sqlitePath = join(dir, 'pending.db')
    await migratedSqlite(sqlitePath)
    const raw = new BetterSqlite3(sqlitePath)
    raw
      .prepare(
        `DELETE FROM __drizzle_migrations WHERE id IN (SELECT id FROM __drizzle_migrations ORDER BY created_at DESC LIMIT ${PENDING})`,
      )
      .run()
    raw.close()

    const run = await runCli(['doctor'], {
      cwd: REPO_ROOT,
      env: cliEnv({ NYMBAL_SQLITE_PATH: sqlitePath }),
    })
    const migrations = line(run, 'migrations')

    expect(run.code, run.out.slice(-3000)).toBe(1)
    expect(migrations?.status).toBe('down')
    expect(migrations?.detail).toMatch(new RegExp(`\\b${PENDING} pending\\b`))
    expect(migrations?.detail).toContain('nymbal migrate')
    expect(names(doctorLines(run.out))).toEqual(names(doctorLines(healthy.out)))
  }, 60_000)

  it("AC-5 (d): a missing SQLite file: `command store` is down naming `nymbal migrate`, `migrations` is down as not checked, the names are the healthy run's, and no file is created", async () => {
    const sqlitePath = join(dir, 'absent', 'nymbal.db')
    const run = await runCli(['doctor'], {
      cwd: REPO_ROOT,
      env: cliEnv({ NYMBAL_SQLITE_PATH: sqlitePath }),
    })
    const store = line(run, 'command store')
    const migrations = line(run, 'migrations')

    expect(run.code, run.out.slice(-3000)).toBe(1)
    expect(store?.status).toBe('down')
    expect(store?.detail).toContain('nymbal migrate')
    expect(migrations?.status).toBe('down')
    expect(migrations?.detail).toContain('not checked: command store down')
    expect(names(doctorLines(run.out))).toEqual(names(doctorLines(healthy.out)))
    expect(
      [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`].filter((p) => existsSync(p)),
    ).toEqual([])
  }, 60_000)

  it("AC-5 (e): documentStore 'postgres-jsonb' on a SQLite command store: only the `config` line, down, carrying the schema's own message", async () => {
    const parsed = nymbalConfigSchema.safeParse({
      ...repoConfig,
      infrastructure: {
        ...repoConfig.infrastructure,
        commandStore: 'sqlite',
        documentStore: 'postgres-jsonb',
      },
    })
    expect(parsed.success).toBe(false)
    const message = parsed.error!.issues.find((i) => i.path.includes('documentStore'))!.message

    const run = await runCli(['doctor'], {
      cwd: REPO_ROOT,
      env: cliEnv({
        NYMBAL_COMMAND_STORE: 'sqlite',
        NYMBAL_DOCUMENT_STORE: 'postgres-jsonb',
        NYMBAL_SQLITE_PATH: join(dir, 'healthy.db'),
      }),
    })
    const lines = doctorLines(run.out)

    expect(run.code, run.out.slice(-3000)).toBe(1)
    expect(lines.map((l) => [l.status, l.name])).toEqual([['down', 'config']])
    expect(lines[0]!.detail).toContain(message)
  }, 60_000)
})
