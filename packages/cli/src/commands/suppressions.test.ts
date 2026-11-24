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

interface Suppressed {
  email: string
  reason: string
  createdAt: string
}

/** A migrated SQLite store holding `rows`, written in the order given. */
function fixtureOf(rows: Suppressed[]): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'suppressions-'))
  dirs.push(dir)
  const path = join(dir, 'nymbal.db')
  copyFileSync(template, path)
  const db = new BetterSqlite3(path)
  try {
    const insert = db.prepare(
      'INSERT INTO email_suppressions (email, reason, event_id, created_at) VALUES (?, ?, ?, ?)',
    )
    for (const row of rows) insert.run(row.email, row.reason, `event-${row.email}`, row.createdAt)
  } finally {
    db.close()
  }
  const project = sqliteProject(path)
  dirs.push(project.dir)
  return { path, project }
}

/** A migrated SQLite store holding a hard-bounce suppression row for each of `emails`. */
function fixture(emails: string[]): Fixture {
  return fixtureOf(
    emails.map((email) => ({
      email,
      reason: 'hard_bounce',
      createdAt: '2026-11-01T10:00:00.000Z',
    })),
  )
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

const suppressionsRun = (f: Fixture, args: string[]) =>
  runCli(['suppressions', ...args], { cwd: f.project.dir, env: f.project.env })

describe('nymbal suppressions show', () => {
  it('AC-12: for a suppressed address typed with spaces and mixed case it exits 0 and prints the normalised address, its reason and its date, and the store is unchanged', async () => {
    const f = fixtureOf([
      { email: 'bounced@example.com', reason: 'complaint', createdAt: '2026-10-15T08:30:00.000Z' },
      { email: 'kept@example.com', reason: 'hard_bounce', createdAt: '2026-11-01T10:00:00.000Z' },
    ])
    const before = hashOf(f.path)

    const run = await suppressionsRun(f, ['show', ' Bounced@Example.COM '])

    expect([run.code, stdoutLines(run.stdout)], run.out.slice(-1000)).toEqual([
      0,
      ['bounced@example.com is suppressed (complaint, 2026-10-15)'],
    ])
    unchanged(f.path, before, run)
  }, 60_000)

  it('AC-12: for an address not suppressed it exits 1, names the normalised address on stderr, and the store is unchanged', async () => {
    const f = fixture(['kept@example.com'])
    const before = hashOf(f.path)

    const run = await suppressionsRun(f, ['show', ' Nobody@Example.COM '])

    expect([run.code, stdoutLines(run.stdout)], run.out.slice(-1000)).toEqual([1, []])
    expect(run.stderr).toContain('nymbal suppressions: nobody@example.com is not suppressed')
    unchanged(f.path, before, run)
  }, 60_000)
})

describe('nymbal suppressions list', () => {
  // Written oldest, newest, middle: the listing's order is the dates', never the rows'.
  const THREE: Suppressed[] = [
    { email: 'oldest@example.com', reason: 'hard_bounce', createdAt: '2026-09-01T12:00:00.000Z' },
    { email: 'newest@example.com', reason: 'complaint', createdAt: '2026-11-05T07:15:00.000Z' },
    { email: 'middle@example.com', reason: 'hard_bounce', createdAt: '2026-10-20T23:59:00.000Z' },
  ]

  it('AC-13: with three suppressions it prints three lines newest first, each the address, reason and date; --limit 2 prints the first two of them and a stderr line naming 2 of 3; the store is unchanged', async () => {
    const f = fixtureOf(THREE)
    const before = hashOf(f.path)

    const all = await suppressionsRun(f, ['list'])
    const two = await suppressionsRun(f, ['list', '--limit', '2'])

    expect([all.code, stdoutLines(all.stdout)], all.out.slice(-1000)).toEqual([
      0,
      [
        'newest@example.com  complaint  2026-11-05',
        'middle@example.com  hard_bounce  2026-10-20',
        'oldest@example.com  hard_bounce  2026-09-01',
      ],
    ])
    expect([two.code, stdoutLines(two.stdout)], two.out.slice(-1000)).toEqual([
      0,
      stdoutLines(all.stdout).slice(0, 2),
    ])
    expect(two.stderr.trim().split('\n').at(-1)).toBe('2 of 3 shown: --limit 3 lists all')
    unchanged(f.path, before, two)
  }, 60_000)

  it('AC-13: an empty store prints no suppressed addresses and exits 0', async () => {
    const f = fixtureOf([])
    const before = hashOf(f.path)

    const run = await suppressionsRun(f, ['list'])

    expect([run.code, stdoutLines(run.stdout)], run.out.slice(-1000)).toEqual([
      0,
      ['no suppressed addresses'],
    ])
    unchanged(f.path, before, run)
  }, 60_000)

  it('AC-13: --limit 0 and --limit x each exit 2 and list nothing, and the store is unchanged', async () => {
    const f = fixtureOf(THREE)
    const before = hashOf(f.path)

    const zero = await suppressionsRun(f, ['list', '--limit', '0'])
    const word = await suppressionsRun(f, ['list', '--limit', 'x'])

    expect(
      [zero, word].map((run) => [run.code, stdoutLines(run.stdout)]),
      `${zero.out.slice(-500)}\n${word.out.slice(-500)}`,
    ).toEqual([
      [2, []],
      [2, []],
    ])
    unchanged(f.path, before, word)
  }, 60_000)
})
