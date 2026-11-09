import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migratedSqlite, REPO_ROOT, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { sqliteProject, stdoutLines } from '../../../../tests/support/events-cli.js'

// `nymbal suppressions clear <email>` through the built CLI against SQLite stores seeded row by row. Each fixture is a
// rollback-journal copy of one migrated store, so a command that writes changes the file's bytes or leaves a -wal/-shm
// beside it. Needs `pnpm build`.

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (
  path: string,
  options?: { readonly?: boolean },
) => {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  pragma(sql: string): unknown
  close(): void
}

const dirs: string[] = []
let template: string

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suppressions-'))
  dirs.push(dir)
  template = join(dir, 'template.db')
  await migratedSqlite(template)
  const db = new BetterSqlite3(template)
  db.pragma('journal_mode = DELETE')
  db.close()
}, 60_000)

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Fixture {
  path: string
  project: ReturnType<typeof sqliteProject>
}

/** A migrated SQLite store holding a suppression row for each of `emails`. */
function fixture(emails: string[]): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'suppressions-'))
  dirs.push(dir)
  const path = join(dir, 'nymbal.db')
  copyFileSync(template, path)
  const db = new BetterSqlite3(path)
  try {
    const insert = db.prepare(
      'INSERT INTO email_suppressions (email, reason, event_id, created_at) VALUES (?, ?, ?, ?)',
    )
    for (const email of emails) {
      insert.run(email, 'hard_bounce', `event-${email}`, '2026-11-01T10:00:00.000Z')
    }
  } finally {
    db.close()
  }
  const project = sqliteProject(path)
  dirs.push(project.dir)
  return { path, project }
}

function storedEmails(path: string): string[] {
  const db = new BetterSqlite3(path, { readonly: true })
  try {
    const rows = db.prepare('SELECT email FROM email_suppressions ORDER BY email').all() as Array<{
      email: string
    }>
    return rows.map((r) => r.email)
  } finally {
    db.close()
  }
}

const hashOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function unchanged(path: string, before: string, run: CliRun): void {
  expect(
    [existsSync(`${path}-wal`), existsSync(`${path}-shm`)],
    'a -wal or -shm beside the store',
  ).toEqual([false, false])
  expect(hashOf(path), `the store's bytes after the run\n${run.out.slice(-1000)}`).toBe(before)
}

const clearRun = (f: Fixture, arg: string) =>
  runCli(['suppressions', 'clear', arg], { cwd: f.project.dir, env: f.project.env })

describe('nymbal suppressions clear', () => {
  it('AC-2: on a store holding the suppression, a spaced, mixed-case address exits 0, prints cleared with the normalised address, and removes only that row', async () => {
    const f = fixture(['bounced@example.com', 'kept@example.com'])

    const run = await clearRun(f, ' Bounced@Example.COM ')

    expect(run.code, run.out.slice(-1000)).toBe(0)
    expect(stdoutLines(run.stdout)).toEqual([
      'cleared bounced@example.com (hard_bounce, 2026-11-01)',
    ])
    expect(storedEmails(f.path)).toEqual(['kept@example.com'])
  }, 60_000)

  it('AC-3: an address not suppressed exits 1, names the normalised address on stderr and leaves the store as it was', async () => {
    const f = fixture(['kept@example.com'])
    const before = hashOf(f.path)

    const run = await clearRun(f, ' Nobody@Example.COM ')

    expect(run.code, run.out.slice(-1000)).toBe(1)
    expect(run.stderr, run.out.slice(-1000)).toContain('nobody@example.com is not suppressed')
    unchanged(f.path, before, run)
  }, 60_000)

  it('AC-3: an argument with no @ exits 2 and never reaches the store', async () => {
    const f = fixture(['kept@example.com'])
    const before = hashOf(f.path)

    const run = await clearRun(f, 'not-an-address')

    expect(run.code, run.out.slice(-1000)).toBe(2)
    expect(run.stderr.length, run.out.slice(-1000)).toBeGreaterThan(0)
    expect(run.stderr).not.toContain('is not suppressed')
    unchanged(f.path, before, run)
  }, 60_000)

  it('AC-3: a project with no SQLite file exits 2, says run nymbal migrate, and creates no file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'suppressions-'))
    dirs.push(dir)
    const missing = join(dir, 'absent.db')
    const project = sqliteProject(missing)
    dirs.push(project.dir)

    const run = await runCli(['suppressions', 'clear', 'someone@example.com'], {
      cwd: project.dir,
      env: project.env,
    })

    expect(run.code, run.out.slice(-1000)).toBe(2)
    expect(run.stderr).toContain('run `nymbal migrate`')
    expect(existsSync(missing), 'the command created the database').toBe(false)
  }, 60_000)
})
