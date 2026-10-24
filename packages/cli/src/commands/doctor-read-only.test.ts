import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import repoConfig from '../../../../nymbal.config.js'
import {
  cliEnv,
  doctorLines,
  migratedSqlite,
  REPO_ROOT,
  runCli,
} from '../../../../tests/support/doctor.js'

// AC-6 (a), SQLite: `nymbal doctor` leaves the database file, `.env` and nymbal.config.ts byte for byte as they were,
// in WAL mode and in rollback mode (whose header a `journal_mode = WAL` pragma would rewrite). The Postgres and Redis
// half is packages/platform/tests/primitives/doctor-read-only.test.ts. Spawns the built CLI.

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (path: string) => {
  pragma(sql: string): unknown
  close(): void
}

const hashOf = (path: string) =>
  existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent'

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.each(['wal', 'delete'] as const)(
  'AC-6 (a): doctor on a SQLite project in %s journal mode writes nothing',
  (mode) => {
    it(`AC-6 (a): the main db file (${mode} mode), .env and nymbal.config.ts hash the same after doctor exits, and doctor reached the db`, async () => {
      const project = mkdtempSync(join(tmpdir(), `nymbal-doctor-ro-${mode}-`))
      dirs.push(project)
      const dbPath = join(project, 'nymbal.db')
      const raw = {
        ...repoConfig,
        infrastructure: {
          commandStore: 'sqlite',
          documentStore: 'in-memory',
          eventBus: 'in-process',
        },
      }
      writeFileSync(
        join(project, 'nymbal.config.ts'),
        `export default ${JSON.stringify(raw, null, 2)}\n`,
      )
      writeFileSync(
        join(project, '.env'),
        `NYMBAL_SQLITE_PATH=${dbPath}\nP2_09_WITNESS=unchanged\n`,
      )
      await migratedSqlite(dbPath)
      if (mode === 'delete') {
        const db = new BetterSqlite3(dbPath)
        db.pragma('journal_mode = DELETE')
        db.close()
      }
      const files = [dbPath, join(project, '.env'), join(project, 'nymbal.config.ts')]
      const before = files.map(hashOf)

      const run = await runCli(['doctor'], { cwd: project, env: cliEnv() })
      const lines = doctorLines(run.out)
      const status = (name: string) => lines.find((l) => l.name === name)?.status

      expect([status('command store'), status('migrations')], run.out.slice(-3000)).toEqual([
        'ok',
        'ok',
      ])
      // The hashes taken before doctor ran equal the ones taken after it exited.
      expect(before).toEqual(files.map(hashOf))
    }, 60_000)
  },
)
