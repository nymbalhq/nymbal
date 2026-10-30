import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, conventionPackage, nymbalConfigSchema } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import { installLine } from '../../../platform/src/adapters/index.js'
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

// AC-5 (b) to (e): each failure exits 1 with a `down` line naming its cause, and the other checks still run.
// (b) a provider's package is not installed: the child runs with a module.register() resolve hook that resolves the
//     adapter as if imported from an empty directory, since in the monorepo it would resolve whatever the cwd;
// (c) a database with 2 migrations unapplied. Rows go by rowid: Drizzle's SQLite journal declares
//     `id SERIAL PRIMARY KEY`, not a rowid alias, so every `id` is NULL;
// (d) a missing SQLite file, which still does not exist afterwards;
// (e) a slot-rule violation: only `config`, carrying the schema's own message.
// (a) runs on the scaffold in tests/stores/nymbal-add-redis.test.ts; (f) is in
// packages/platform/tests/integration/diagnose-no-healthcheck.test.ts. Spawns the built CLI (`pnpm build` first).

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (path: string) => {
  prepare(sql: string): { run(): unknown; get(): unknown }
  close(): void
}

const PENDING = 2

let dir = ''
let healthy: CliRun

const repo = onDefaultStores(repoConfig)

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
const names = (lines: DoctorLine[]) => lines.map((l) => l.name)
const line = (run: CliRun, name: string) => doctorLines(run.out).find((l) => l.name === name)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-fail-'))
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

describe('AC-5: each failure exits 1 and names its cause', () => {
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
        documentStore: { provider: 'in-memory' },
        eventBus: { provider: 'in-process' },
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
    const stripe = {
      package: conventionPackage('payments', 'stripe'),
      sdk: ADAPTER_CATALOGUE.payments['stripe']!.sdk!,
    }
    const env = cliEnv({
      NYMBAL_SQLITE_PATH: sqlitePath,
      NODE_OPTIONS: hiding([stripe.package]),
    })

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
    const count = () =>
      (raw.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n
    const before = count()
    raw
      .prepare(
        `DELETE FROM __drizzle_migrations WHERE rowid IN (SELECT rowid FROM __drizzle_migrations ORDER BY created_at DESC, rowid DESC LIMIT ${PENDING})`,
      )
      .run()
    const after = count()
    raw.close()
    expect(after).toBe(before - PENDING)

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
        documentStore: { provider: 'postgres-jsonb' },
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
