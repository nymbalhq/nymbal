import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EVT_CATEGORY_CREATED, type NymbalEvent } from '@nymbalhq/types'
import {
  doctorJson,
  doctorLines,
  migratedSqlite,
  REPO_ROOT,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'
import { parseLine, sqliteProject, stdoutLines } from '../../../../tests/support/events-cli.js'
import { createEventBuilder } from '../../../platform/src/events/builder.js'
import { TEST_BUILDER_CONTEXT } from '../../../platform/src/tests/publisher.js'
import { createKernel } from '../../../platform/tests/support/kernel.js'
import { eventRows, failPublishFor, maxSeq } from '../../../platform/tests/support/outbox.js'
import { openRaw } from '../../../platform/tests/support/raw.js'

// `nymbal events retry` and the doctor's line for dead events, through the built CLI against SQLite stores whose log
// is seeded row by row, ages and states included. Each fixture is a rollback-journal copy of one migrated store, so a
// command that writes changes the file's bytes or leaves a -wal/-shm beside it. Needs `pnpm build`.

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
  exec(sql: string): void
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  close(): void
}

const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)
const DAY_MS = 24 * 60 * 60_000
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS)
/** A dead row in the retention window of every project below. */
const RECENT = (): Date => daysAgo(1)
/** Past the 30-day default window. */
const OLD = (): Date => daysAgo(40)

interface SeedRow {
  type: string
  createdAt: Date
  dead?: boolean
  delivered?: boolean
  /** An undelivered row with attempts behind it, waiting for its retry. */
  waiting?: boolean
}

interface Stored {
  seq: number
  id: string
  type: string
  attempts: number
  deliveredAt: string | null
  deadAt: string | null
  retryAt: string | null
  createdAt: string
  timestamp: string
  correlationId: string
}

const dirs: string[] = []
let template: string

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-retry-'))
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

function storedRows(path: string): Stored[] {
  const db = new BetterSqlite3(path, { readonly: true })
  try {
    const rows = db
      .prepare(
        `SELECT seq, id, type, attempts, delivered_at, dead_at, retry_at, created_at, envelope
           FROM events ORDER BY seq`,
      )
      .all() as Array<{
      seq: number
      id: string
      type: string
      attempts: number
      delivered_at: string | null
      dead_at: string | null
      retry_at: string | null
      created_at: string
      envelope: string
    }>
    return rows.map((r) => {
      const envelope = JSON.parse(r.envelope) as NymbalEvent<unknown>
      return {
        seq: Number(r.seq),
        id: r.id,
        type: r.type,
        attempts: Number(r.attempts),
        deliveredAt: r.delivered_at,
        deadAt: r.dead_at,
        retryAt: r.retry_at,
        createdAt: r.created_at,
        timestamp: envelope.timestamp,
        correlationId: envelope.correlationId,
      }
    })
  } finally {
    db.close()
  }
}

/** A migrated SQLite store holding `rows`, in order, by seq. */
function fixture(rows: SeedRow[]): { path: string; project: ReturnType<typeof sqliteProject> } {
  const dir = mkdtempSync(join(tmpdir(), 'events-retry-'))
  dirs.push(dir)
  const path = join(dir, 'nymbal.db')
  copyFileSync(template, path)
  const db = new BetterSqlite3(path)
  try {
    const insert = db.prepare(
      `INSERT INTO events (id, type, envelope, correlation_id, created_at, attempts, delivered_at, dead_at, retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertAll = db.transaction(((items: SeedRow[]) => {
      for (const row of items) {
        const event = makeEvent(row.type, { seeded: randomUUID() })
        const after = (ms: number) => new Date(row.createdAt.getTime() + ms).toISOString()
        insert.run(
          event.id,
          event.type,
          JSON.stringify(event),
          event.correlationId,
          row.createdAt.toISOString(),
          row.dead === true ? 5 : row.waiting === true ? 2 : 0,
          row.delivered === true ? after(10_000) : null,
          row.dead === true ? after(160_000) : null,
          row.dead === true || row.waiting === true ? after(320_000) : null,
        )
      }
    }) as never) as unknown as (items: SeedRow[]) => void
    insertAll(rows)
  } finally {
    db.close()
  }
  const project = sqliteProject(path)
  dirs.push(project.dir)
  return { path, project }
}

const hashOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function unchanged(path: string, before: string, run: CliRun): void {
  expect(
    [existsSync(`${path}-wal`), existsSync(`${path}-shm`)],
    'a -wal or -shm beside the store',
  ).toEqual([false, false])
  expect(hashOf(path), `the store's bytes after the run\n${run.out.slice(-1000)}`).toBe(before)
}

const retryRun = (f: { project: ReturnType<typeof sqliteProject> }, args: string[]) =>
  runCli(['events', 'retry', ...args], { cwd: f.project.dir, env: f.project.env })

const deadOf = (rows: Stored[]) => rows.filter((r) => r.deadAt !== null)
const deadSeqs = (path: string) => deadOf(storedRows(path)).map((r) => r.seq)
const cleared = (r: Stored) => [r.deadAt, r.attempts, r.retryAt]
const CLEARED = [null, 0, null]

/** The summary line of a retry run that retried, or undefined. */
const summaryOf = (run: CliRun) => stdoutLines(run.stdout).find((l) => /^retried \d+; /.test(l))

const LISTING = /^(\d+) (\S+) (\S+) (\S+) (\S+) dead (\S+)$/

/** The listing lines of a bare run: seq, type, id and dead time, in the order printed. */
function listingOf(run: CliRun) {
  return stdoutLines(run.stdout)
    .map((line) => LISTING.exec(line.replace(/ past-retention$/, '')))
    .filter((m) => m !== null)
    .map((m) => ({ seq: Number(m[1]), type: m[3], id: m[5], deadAt: m[6]! }))
}

const NONE_DEAD = 'none dead'

const FLOW: SeedRow[] = [
  { type: 'category.created.v1', createdAt: RECENT(), dead: true },
  { type: 'order.paid.v1', createdAt: RECENT(), delivered: true },
  { type: 'product.created.v1', createdAt: RECENT(), dead: true },
  { type: 'order.placed.v1', createdAt: RECENT(), waiting: true },
  { type: 'category.deleted.v1', createdAt: RECENT(), dead: true },
]

describe('nymbal events retry', { timeout: 60_000 }, () => {
  it('AC-9: bare, it lists the dead events oldest first with their dead time and the count line, exits 0, and leaves the store file unchanged', async () => {
    const f = fixture(FLOW)
    const dead = deadOf(storedRows(f.path))
    const before = hashOf(f.path)

    const run = await retryRun(f, [])

    expect(listingOf(run), run.out.slice(-1000)).toEqual(
      dead.map((r) => ({
        seq: r.seq,
        type: r.type,
        id: r.id,
        deadAt: new Date(r.deadAt!).toISOString(),
      })),
    )
    const lines = stdoutLines(run.stdout)
    expect(lines[dead.length], 'the count line follows the listing').toMatch(
      new RegExp(`^${dead.length} dead: nymbal events retry --all`),
    )
    expect(run.code, run.out.slice(-1000)).toBe(0)
    unchanged(f.path, before, run)
  })

  it('AC-9: bare on a log with no dead event, it prints none dead, exits 0 and leaves the store file unchanged', async () => {
    const f = fixture([{ type: 'order.paid.v1', createdAt: RECENT(), delivered: true }])
    const before = hashOf(f.path)

    const run = await retryRun(f, [])

    expect(stdoutLines(run.stdout), run.out.slice(-1000)).toEqual([NONE_DEAD])
    expect(run.code).toBe(0)
    unchanged(f.path, before, run)
  })

  it('AC-10: --all clears every dead row and no other, prints one line per retried event, `retried N; 0 still dead` with N the rows moved, and exits 0', async () => {
    const f = fixture(FLOW)
    const before = storedRows(f.path)
    const dead = deadOf(before)

    const run = await retryRun(f, ['--all'])

    const after = storedRows(f.path)
    expect(
      deadOf(after).map((r) => r.seq),
      `dead rows after --all\n${run.out.slice(-1000)}`,
    ).toEqual([])
    expect(dead.map((r) => cleared(after.find((a) => a.seq === r.seq)!))).toEqual(
      dead.map(() => CLEARED),
    )
    expect(after.filter((r) => !dead.some((d) => d.seq === r.seq))).toEqual(
      before.filter((r) => !dead.some((d) => d.seq === r.seq)),
    )
    expect(
      stdoutLines(run.stdout)
        .map(parseLine)
        .filter((l) => l !== null)
        .map((l) => l.seq),
    ).toEqual(dead.map((r) => r.seq))
    expect(summaryOf(run)).toBe(`retried ${dead.length}; 0 still dead`)
    expect(run.code, run.out.slice(-1000)).toBe(0)
  })

  it('AC-8: a retry of a dead row already marked delivered clears it, keeps its delivered_at and reports it already delivered, not sent again', async () => {
    const f = fixture([
      { type: 'order.placed.v1', createdAt: RECENT(), dead: true, delivered: true },
      { type: 'order.paid.v1', createdAt: RECENT(), dead: true },
    ])
    const [before] = storedRows(f.path)

    const run = await retryRun(f, ['--all'])

    const after = storedRows(f.path)
    expect(cleared(after[0]!), `the delivered row\n${run.out.slice(-1000)}`).toEqual(CLEARED)
    expect(after[0]!.deliveredAt, 'its delivered_at').toBe(before!.deliveredAt)
    expect(stdoutLines(run.stdout)).toContain('1 already delivered: cleared, not sent again')
    expect(run.code).toBe(0)
  })

  it('AC-11: a positional seq retries exactly that row, prints `retried 1; M still dead` with M the other dead rows, and exits 0', async () => {
    const f = fixture(FLOW)
    const rows = storedRows(f.path)
    const dead = deadOf(rows)
    const target = dead[1]!

    const run = await retryRun(f, [String(target.seq)])

    expect(deadSeqs(f.path), `dead rows after the retry\n${run.out.slice(-1000)}`).toEqual(
      dead.filter((r) => r.seq !== target.seq).map((r) => r.seq),
    )
    expect(summaryOf(run)).toBe(`retried 1; ${dead.length - 1} still dead`)
    expect(run.code).toBe(0)
  })

  it('AC-11: a positional event id retries exactly that row, and is not read as a seq', async () => {
    const f = fixture(FLOW)
    const rows = storedRows(f.path)
    const dead = deadOf(rows)
    const target = dead[2]!

    const run = await retryRun(f, [target.id])

    expect(deadSeqs(f.path), `dead rows after the retry\n${run.out.slice(-1000)}`).toEqual(
      dead.filter((r) => r.seq !== target.seq).map((r) => r.seq),
    )
    expect(summaryOf(run)).toBe(`retried 1; ${dead.length - 1} still dead`)
    expect(run.code).toBe(0)
  })

  it('AC-12: --type with --since and --until retries only the dead rows matching all three, prints the counts and exits 0', async () => {
    const at = (n: number) => daysAgo(n)
    const T = at(5)
    const U = at(2)
    const f = fixture([
      { type: 'category.created.v1', createdAt: at(6), dead: true },
      { type: 'category.created.v1', createdAt: T, dead: true },
      { type: 'category.updated.v1', createdAt: at(3), dead: true },
      { type: 'order.paid.v1', createdAt: at(3), dead: true },
      { type: 'category.created.v1', createdAt: U, dead: true },
      { type: 'category.created.v1', createdAt: at(1), dead: true },
    ])
    const before = storedRows(f.path)
    const dead = deadOf(before)
    const matching = dead.filter((r) => {
      const t = new Date(r.createdAt).getTime()
      return r.type.startsWith('category.') && t >= T.getTime() && t < U.getTime()
    })
    expect(matching.length, 'the fixture: at the window start and inside it').toBe(2)

    const run = await retryRun(f, [
      '--type',
      'category.*',
      '--since',
      T.toISOString(),
      '--until',
      U.toISOString(),
    ])

    expect(deadSeqs(f.path), `dead rows after the retry\n${run.out.slice(-1000)}`).toEqual(
      dead.filter((r) => !matching.includes(r)).map((r) => r.seq),
    )
    expect(summaryOf(run)).toBe(
      `retried ${matching.length}; ${dead.length - matching.length} still dead`,
    )
    expect(run.code).toBe(0)
  })

  it('AC-13: --dry-run with a selector prints the selected rows and `would retry N` with N what a real retry moves, and leaves the store file unchanged', async () => {
    const f = fixture([...FLOW, { type: 'category.updated.v1', createdAt: OLD(), dead: true }])
    const twin = join(mkdtempSync(join(tmpdir(), 'events-retry-')), 'nymbal.db')
    dirs.push(join(twin, '..'))
    copyFileSync(f.path, twin)
    const before = hashOf(f.path)

    const dry = await retryRun(f, ['--type', 'category.*', '--dry-run'])

    const selected = deadOf(storedRows(f.path)).filter((r) => r.type.startsWith('category.'))
    expect(listingOf(dry), dry.out.slice(-1000)).toEqual(
      selected.map((r) => ({
        seq: r.seq,
        type: r.type,
        id: r.id,
        deadAt: new Date(r.deadAt!).toISOString(),
      })),
    )
    const would = /^would retry (\d+) \(dry run, nothing written\)$/.exec(
      stdoutLines(dry.stdout).find((l) => l.startsWith('would retry')) ?? '',
    )
    expect(dry.code, dry.out.slice(-1000)).toBe(0)
    expect(hashOf(f.path)).toBe(before)

    const real = await runCli(['events', 'retry', '--type', 'category.*'], {
      cwd: sqliteProject(twin).dir,
      env: sqliteProject(twin).env,
    })
    const moved = storedRows(twin)
      .filter((r) => selected.some((s) => s.seq === r.seq))
      .filter((r) => r.deadAt === null).length
    expect(Number(would?.[1]), `the dry run's count against the real run\n${real.out}`).toBe(moved)
    expect(moved, 'what the real run moved: every selected row but the one past retention').toBe(
      selected.length - 1,
    )
    const pastRetention =
      '1 past retention (events.retentionDays 30): their delivery records are gone, so a retry could repeat side effects; left dead'
    expect(stdoutLines(dry.stdout), 'the dry run names the row it leaves').toContain(pastRetention)
    expect(stdoutLines(real.stdout), 'the real run names the row it left').toContain(pastRetention)
    unchanged(f.path, before, dry)
  })

  it('AC-13: --dry-run with a selector that matches nothing retryable exits 1, as the real run does, and writes nothing', async () => {
    const f = fixture([{ type: 'order.paid.v1', createdAt: OLD(), dead: true }])
    const before = hashOf(f.path)

    const run = await retryRun(f, ['--dry-run', '--type', 'order.*'])

    expect(run.stderr, run.out.slice(-1000)).toContain('past retention')
    expect(run.code).toBe(1)
    unchanged(f.path, before, run)
  })

  it('AC-13: bare --dry-run prints the bare listing and exits 0, and --dry-run --all on an empty log prints none dead and exits 0', async () => {
    const f = fixture(FLOW)
    const before = hashOf(f.path)
    const empty = fixture([{ type: 'order.paid.v1', createdAt: RECENT(), delivered: true }])
    const emptyBefore = hashOf(empty.path)

    const bare = await retryRun(f, ['--dry-run'])
    const none = await retryRun(empty, ['--dry-run', '--all'])

    expect(
      listingOf(bare).map((l) => l.seq),
      bare.out.slice(-1000),
    ).toEqual(deadOf(storedRows(f.path)).map((r) => r.seq))
    expect(bare.code).toBe(0)
    expect(stdoutLines(none.stdout), none.out.slice(-1000)).toEqual([NONE_DEAD])
    expect(none.code).toBe(0)
    unchanged(f.path, before, bare)
    unchanged(empty.path, emptyBefore, none)
  })

  it('AC-14: --all on a log with nothing dead prints none dead and exits 0', async () => {
    const f = fixture([{ type: 'order.paid.v1', createdAt: RECENT(), delivered: true }])

    const run = await retryRun(f, ['--all'])

    expect(stdoutLines(run.stdout), run.out.slice(-1000)).toEqual([NONE_DEAD])
    expect(run.code).toBe(0)
  })

  it('AC-14: a selection whose every row is past retention exits 1 with past retention on stderr and writes nothing', async () => {
    const f = fixture([
      { type: 'order.paid.v1', createdAt: OLD(), dead: true },
      { type: 'order.placed.v1', createdAt: OLD(), dead: true },
    ])
    const before = hashOf(f.path)

    const run = await retryRun(f, ['--type', 'order.*'])

    expect(run.stderr, run.out.slice(-1000)).toContain('past retention')
    expect(run.code).toBe(1)
    expect(hashOf(f.path)).toBe(before)
  })

  it('AC-14: a seq no event has exits 1 with no event on stderr and writes nothing', async () => {
    const f = fixture(FLOW)
    const before = hashOf(f.path)

    const run = await retryRun(f, ['999999'])

    expect(run.stderr, run.out.slice(-1000)).toContain('no event')
    expect(run.code).toBe(1)
    expect(hashOf(f.path)).toBe(before)
  })

  it('AC-14: a seq of a delivered or waiting event exits 1 with is not dead on stderr and leaves the row as it was', async () => {
    const f = fixture(FLOW)
    const rows = storedRows(f.path)
    const delivered = rows.find((r) => r.deliveredAt !== null)!
    const waiting = rows.find((r) => r.deliveredAt === null && r.deadAt === null)!

    for (const target of [delivered, waiting]) {
      const run = await retryRun(f, [String(target.seq)])
      expect(run.stderr, `seq ${target.seq}\n${run.out.slice(-1000)}`).toContain('is not dead')
      expect(run.code).toBe(1)
      expect(storedRows(f.path).find((r) => r.seq === target.seq)).toEqual(target)
    }
  })

  it('AC-14: filters that match no dead event exit 1 with no dead event matches on stderr and write nothing', async () => {
    const f = fixture(FLOW)
    const before = hashOf(f.path)

    const run = await retryRun(f, ['--type', 'cart.*'])

    expect(run.stderr, run.out.slice(-1000)).toContain('no dead event matches')
    expect(run.code).toBe(1)
    expect(hashOf(f.path)).toBe(before)
  })

  it('AC-14: a partial selection exits 0 and says how many are still dead', async () => {
    const f = fixture(FLOW)
    const dead = deadOf(storedRows(f.path))

    const run = await retryRun(f, ['--type', 'product.*'])

    expect(summaryOf(run), run.out.slice(-1000)).toBe(`retried 1; ${dead.length - 1} still dead`)
    expect(run.code).toBe(0)
  })

  for (const [name, args] of [
    ['a positional that is neither a seq nor an id', ['abc']],
    ['a bad --since', ['--since', 'yesterday']],
    ['an empty --type', ['--type', '']],
    ['a seq and --all', ['5', '--all']],
    ['--all and a filter', ['--all', '--type', 'x']],
  ] as const) {
    it(`AC-14: ${name} exits 2 with a reason on stderr and writes nothing`, async () => {
      const f = fixture(FLOW)
      const before = hashOf(f.path)

      const run = await retryRun(f, [...args])

      expect(run.stderr.trim(), run.out.slice(-1000)).toMatch(/^nymbal events: \S/)
      expect(run.code).toBe(2)
      unchanged(f.path, before, run)
    })
  }

  it('AC-14: a missing SQLite file exits 2 with a reason on stderr and creates no file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-retry-'))
    dirs.push(dir)
    const missing = join(dir, 'absent.db')
    const project = sqliteProject(missing)
    dirs.push(project.dir)

    const run = await runCli(['events', 'retry', '--all'], { cwd: project.dir, env: project.env })

    expect(run.stderr.trim(), run.out.slice(-1000)).toMatch(/^nymbal events: \S/)
    expect(run.code).toBe(2)
    expect(existsSync(missing), 'the command created the database').toBe(false)
  })

  it('AC-18: with events.retentionDays 7 in the project config, a dead row appended 8 days ago stays dead and one appended 6 days ago is retried, where the 30-day default would have taken both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-retry-'))
    dirs.push(dir)
    const path = join(dir, 'nymbal.db')
    copyFileSync(template, path)
    const twin = fixture([
      { type: 'order.placed.v1', createdAt: daysAgo(8), dead: true },
      { type: 'order.paid.v1', createdAt: daysAgo(6), dead: true },
    ])
    copyFileSync(twin.path, path)
    const project = sqliteProject(path, { events: { retentionDays: 7 } })
    dirs.push(project.dir)
    const rows = storedRows(path)
    const old = rows.find((r) => r.type === 'order.placed.v1')!

    const run = await runCli(['events', 'retry', '--all'], { cwd: project.dir, env: project.env })

    expect(deadSeqs(path), `dead rows after --all\n${run.out.slice(-1000)}`).toEqual([old.seq])
    expect(summaryOf(run)).toBe('retried 1; 1 still dead')
    expect(stdoutLines(run.stdout).join('\n')).toContain(
      '1 past retention (events.retentionDays 7)',
    )
    expect(run.code).toBe(0)

    const onDefault = await retryRun(twin, ['--all'])
    expect(deadSeqs(twin.path), `the default window\n${onDefault.out.slice(-1000)}`).toEqual([])
  })

  it('AC-18: with events.retentionDays 7, selecting only a row appended 8 days ago exits 1, says past retention and leaves it dead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-retry-'))
    dirs.push(dir)
    const path = join(dir, 'nymbal.db')
    const twin = fixture([{ type: 'order.placed.v1', createdAt: daysAgo(8), dead: true }])
    copyFileSync(twin.path, path)
    const project = sqliteProject(path, { events: { retentionDays: 7 } })
    dirs.push(project.dir)
    const [row] = storedRows(path)
    const before = hashOf(path)

    const run = await runCli(['events', 'retry', String(row!.seq)], {
      cwd: project.dir,
      env: project.env,
    })

    expect(run.stderr, run.out.slice(-1000)).toContain('past retention (events.retentionDays 7)')
    expect(run.code).toBe(1)
    expect(hashOf(path)).toBe(before)
  })

  it('AC-21: --all over more than 100 retryable rows moves the 100 oldest and says how many remain, each further run the next 100, oldest first, until none are left', async () => {
    const n = 205
    const f = fixture(
      Array.from({ length: n }, () => ({
        type: 'category.created.v1',
        createdAt: RECENT(),
        dead: true,
      })),
    )
    const seqs = deadSeqs(f.path)
    expect(seqs.length, 'the fixture').toBe(n)
    const before = hashOf(f.path)

    const dry = await retryRun(f, ['--all', '--dry-run'])

    expect(stdoutLines(dry.stdout), dry.out.slice(-1000)).toEqual(
      expect.arrayContaining([
        'would retry 100 (dry run, nothing written)',
        `${n - 100} more selected: run it again for the next 100`,
      ]),
    )
    expect(dry.code).toBe(0)
    unchanged(f.path, before, dry)

    const first = await retryRun(f, ['--all'])

    expect(deadSeqs(f.path), `dead rows after the first run\n${first.out.slice(-1000)}`).toEqual(
      seqs.slice(100),
    )
    expect(summaryOf(first)).toBe(`retried 100; ${n - 100} still dead`)
    expect(first.stdout).toContain('run it again for the next 100')
    expect(first.code).toBe(0)

    const second = await retryRun(f, ['--all'])
    expect(deadSeqs(f.path), 'dead rows after the second run').toEqual(seqs.slice(200))
    expect(summaryOf(second)).toBe(`retried 100; ${n - 200} still dead`)

    const third = await retryRun(f, ['--all'])
    expect(deadSeqs(f.path), 'dead rows after the third run').toEqual([])
    expect(summaryOf(third)).toBe(`retried ${n - 200}; 0 still dead`)
    expect(third.stdout).not.toContain('run it again')

    const fourth = await retryRun(f, ['--all'])
    expect(stdoutLines(fourth.stdout)).toEqual([NONE_DEAD])
  })

  it('AC-6: run against a store serving with its relay, --all puts the dead event back and the running store delivers it with no further command, and the CLI exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-retry-'))
    dirs.push(dir)
    const path = join(dir, 'nymbal.db')
    const kernel = await createKernel({
      dialect: 'sqlite',
      sqlitePath: path,
      appOptions: { relay: { intervalMs: 100 } },
    })
    const raw = openRaw(kernel.dialect, kernel.target)
    try {
      const refusing = failPublishFor(kernel.eventBus, [EVT_CATEGORY_CREATED])
      const before = await maxSeq(raw)
      await kernel.services.category.create({ slug: `dead-${randomUUID()}`, name: 'Dead' })
      const [event] = await eventRows(raw, 'seq > ? AND type = ?', [before, EVT_CATEGORY_CREATED])
      await vi.waitFor(
        async () => {
          await kernel.app.relay.drain()
          const [row] = await eventRows(raw, 'id = ?', [event!.id])
          expect(row!.deadAt != null, 'the event is dead').toBe(true)
        },
        { timeout: 20_000, interval: 50 },
      )
      refusing.restore()
      const handled: string[] = []
      await kernel.eventBus.subscribe(EVT_CATEGORY_CREATED, async (e) => void handled.push(e.id), {
        name: 'retry-cli-probe',
      })
      const project = sqliteProject(path)
      dirs.push(project.dir)

      const run = await runCli(['events', 'retry', '--all'], {
        cwd: project.dir,
        env: project.env,
      })

      await vi.waitFor(
        async () => {
          const [row] = await eventRows(raw, 'id = ?', [event!.id])
          expect(row!.deliveredAt != null, `delivered by the running store\n${run.out}`).toBe(true)
          expect(handled.filter((id) => id === event!.id).length, 'handled').toBe(1)
        },
        { timeout: 20_000, interval: 100 },
      )
      expect(run.code, run.out.slice(-1000)).toBe(0)
    } finally {
      await raw.close()
      await kernel.close()
    }
  }, 90_000)

  describe('doctor', () => {
    const doctor = (f: { project: ReturnType<typeof sqliteProject> }, args: string[] = []) =>
      runCli(['doctor', ...args], { cwd: f.project.dir, env: f.project.env })
    const eventsLine = (run: CliRun) => doctorLines(run.out).find((l) => l.name === 'events')
    const eventsCheck = (run: CliRun) =>
      doctorJson(run.stdout).checks.find((c) => c.name === 'events')

    it('AC-15: with retryable dead events the events line names the command, in text and --json, and is warn', async () => {
      const f = fixture(FLOW)

      const text = await doctor(f)
      const json = await doctor(f, ['--json'])

      const line = eventsLine(text)
      expect(line?.detail, text.out.slice(-1000)).toContain('nymbal events retry')
      expect(line?.status).toBe('warn')
      const check = eventsCheck(json)
      expect(check?.detail).toContain('nymbal events retry')
      expect(check?.status).toBe('degraded')
    })

    it('AC-15: with some dead events past retention, doctor offers the command and counts those it cannot retry', async () => {
      const f = fixture([
        { type: 'order.paid.v1', createdAt: RECENT(), dead: true },
        { type: 'order.placed.v1', createdAt: OLD(), dead: true },
        { type: 'order.created.v1', createdAt: OLD(), dead: true },
      ])

      const text = await doctor(f)

      const detail = eventsLine(text)?.detail ?? ''
      expect(detail, text.out.slice(-1000)).toContain('nymbal events retry')
      expect(detail).toContain('2 past retention cannot be retried')
      expect(eventsLine(text)?.status).toBe('warn')
    })

    it('AC-15: with every dead event past retention, doctor says so and does not offer the command', async () => {
      const f = fixture([
        { type: 'order.paid.v1', createdAt: OLD(), dead: true },
        { type: 'order.placed.v1', createdAt: OLD(), dead: true },
      ])

      const text = await doctor(f)

      const detail = eventsLine(text)?.detail ?? ''
      expect(detail, text.out.slice(-1000)).toContain('all past retention, cannot be retried')
      expect(detail).not.toContain('nymbal events retry')
      expect(eventsLine(text)?.status).toBe('warn')
    })

    it('AC-15: with none dead, doctor does not name the command and is ok, and after a retry commits it reports none dead while the row is undelivered, then names the event again when it dies again', async () => {
      const f = fixture(FLOW)
      const dead = deadOf(storedRows(f.path))

      const retried = await retryRun(f, ['--all'])
      const afterRetry = await doctor(f)

      expect(eventsLine(afterRetry)?.detail ?? '', retried.out.slice(-1000)).toContain(NONE_DEAD)
      expect(eventsLine(afterRetry)?.detail ?? '').not.toContain('nymbal events retry')
      expect(eventsLine(afterRetry)?.status).toBe('ok')
      const moved = storedRows(f.path).filter((r) => dead.some((d) => d.seq === r.seq))
      expect(
        moved.map((r) => r.deliveredAt),
        'the retried rows are not yet delivered',
      ).toEqual(dead.map(() => null))

      const again = dead[0]!
      const db = new BetterSqlite3(f.path)
      db.prepare('UPDATE events SET dead_at = ?, attempts = 5 WHERE seq = ?').run(
        new Date().toISOString(),
        again.seq,
      )
      db.close()
      const afterDeath = await doctor(f)

      const line = eventsLine(afterDeath)
      expect(line?.detail).toMatch(/^1 dead\b/)
      expect(line?.detail).toContain('nymbal events retry')
      expect(line?.status).toBe('warn')
    })
  })
})
