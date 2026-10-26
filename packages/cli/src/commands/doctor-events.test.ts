import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_CATEGORY_CREATED,
  EVT_PRODUCT_CREATED,
  type EventBusAdapter,
  type NymbalEvent,
} from '@nymbalhq/types'
import {
  doctorJson,
  doctorLines,
  migratedSqlite,
  REPO_ROOT,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'
import { sqliteProject, stdoutLines } from '../../../../tests/support/events-cli.js'
import { createKernel, seedVariant } from '../../../platform/tests/support/kernel.js'

// AC-10: `nymbal doctor` names dead events, and `nymbal events query --json` carries each event's attempts and
// deadAt. The built CLI against SQLite stores whose events were made dead (or left waiting to retry) by a bus that
// refuses their type: the relay counts every refusal, and the fifth makes an event dead. Each store is switched to a
// rollback journal, so a command that writes changes the file's bytes. Needs `pnpm build`.

const MAX_ATTEMPTS = 5

/** Makes the bus's publish reject events of `type` until restored (the relay looks `publish` up at call time). */
function failPublishFor(bus: EventBusAdapter, type: string): { restore(): void } {
  const original = bus.publish
  bus.publish = async function <T>(this: EventBusAdapter, event: NymbalEvent<T>) {
    if (event.type === type) throw new Error(`bus unavailable for ${event.type}`)
    return original.call(bus, event)
  }
  return {
    restore() {
      bus.publish = original
    },
  }
}

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (
  path: string,
  options?: { readonly?: boolean },
) => {
  prepare(sql: string): { all(): unknown[] }
  pragma(sql: string): unknown
  close(): void
}

interface StoredRow {
  seq: number
  id: string
  type: string
  correlationId: string
  attempts: number
  deadAt: string | null
}

const dirs: string[] = []
const hashOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function storedRows(dbPath: string): StoredRow[] {
  const db = new BetterSqlite3(dbPath, { readonly: true })
  try {
    return (
      db
        .prepare('SELECT seq, id, type, correlation_id, attempts, dead_at FROM events ORDER BY seq')
        .all() as Array<{
        seq: number
        id: string
        type: string
        correlation_id: string
        attempts: number
        dead_at: string | null
      }>
    ).map((r) => ({
      seq: Number(r.seq),
      id: r.id,
      type: r.type,
      correlationId: r.correlation_id,
      attempts: Number(r.attempts),
      deadAt: r.dead_at,
    }))
  } finally {
    db.close()
  }
}

/** A migrated store with `dead` dead category.created.v1 events and `waiting` product.created.v1 events refused once. */
async function storeWith(dead: number, waiting: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-events-'))
  dirs.push(dir)
  const dbPath = join(dir, 'nymbal.db')
  const kernel = await createKernel({ dialect: 'sqlite', sqlitePath: dbPath })
  try {
    const refusing = failPublishFor(kernel.eventBus, EVT_CATEGORY_CREATED)
    for (let i = 0; i < dead; i += 1) {
      await kernel.services.category.create({ slug: `dead-${randomUUID()}`, name: `Dead ${i}` })
    }
    for (let drain = 1; drain < MAX_ATTEMPTS; drain += 1) await kernel.app.relay.drain()
    refusing.restore()
    const once = failPublishFor(kernel.eventBus, EVT_PRODUCT_CREATED)
    for (let i = 0; i < waiting; i += 1) await seedVariant(kernel, 1)
    once.restore()
  } finally {
    await kernel.close()
  }
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = DELETE')
  db.close()
  return dbPath
}

interface Fixture {
  dbPath: string
  project: { dir: string; env: NodeJS.ProcessEnv }
  rows: StoredRow[]
}

async function fixture(dbPath: string): Promise<Fixture> {
  const project = sqliteProject(dbPath)
  dirs.push(project.dir)
  return { dbPath, project, rows: storedRows(dbPath) }
}

const doctor = (f: Fixture, args: string[] = []) =>
  runCli(['doctor', ...args], { cwd: f.project.dir, env: f.project.env })

const eventsLine = (run: CliRun) => doctorLines(run.out).find((l) => l.name === 'events')

let none: Fixture
let two: Fixture
let seven: Fixture

beforeAll(async () => {
  const empty = join(mkdtempSync(join(tmpdir(), 'doctor-events-none-')), 'nymbal.db')
  dirs.push(join(empty, '..'))
  await migratedSqlite(empty)
  none = await fixture(empty)
  two = await fixture(await storeWith(2, 1))
  seven = await fixture(await storeWith(7, 0))
}, 120_000)

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const deadOf = (f: Fixture) => f.rows.filter((r) => r.deadAt !== null)

describe('AC-10: doctor and the log name dead events', { timeout: 60_000 }, () => {
  it('AC-10: on a store with no dead event, doctor prints an ok events line, none dead and none waiting, and --json has events ok', async () => {
    const text = await doctor(none)
    const json = await doctor(none, ['--json'])

    expect(text.code, text.out.slice(-3000)).toBe(0)
    expect(eventsLine(text), text.out.slice(-3000)).toMatchObject({ status: 'ok' })
    expect(eventsLine(text)?.detail).toMatch(/\bnone dead, 0 waiting to retry\b/)
    expect(doctorJson(json.stdout).checks.find((c) => c.name === 'events')?.status).toBe('ok')
  })

  it('AC-10: with two dead events and one waiting to retry, the events line is warn and names both dead events by seq, type and id, oldest first, and counts the one waiting; --json says degraded; the exit code is 0 with nothing down; the database file is unchanged', async () => {
    const dead = deadOf(two)
    const waiting = two.rows.filter((r) => r.deadAt === null && r.attempts > 0)
    expect([dead.length, waiting.length], 'the fixture').toEqual([2, 1])
    const before = hashOf(two.dbPath)

    const text = await doctor(two)
    const json = await doctor(two, ['--json'])

    const line = eventsLine(text)
    expect(line?.status, text.out.slice(-3000)).toBe('warn')
    expect(line?.detail).toMatch(new RegExp(`^${dead.length} dead\\b`))
    const at = dead.map((r) => line?.detail.indexOf(`seq ${r.seq} ${r.type} ${r.id}`) ?? -1)
    expect(
      at.every((i) => i >= 0),
      `each dead event named in: ${line?.detail}`,
    ).toBe(true)
    expect(at, 'oldest first').toEqual([...at].sort((a, b) => a - b))
    expect(line?.detail).toMatch(new RegExp(`\\b${waiting.length} waiting\\b`))
    expect(doctorJson(json.stdout).checks.find((c) => c.name === 'events')?.status).toBe('degraded')
    expect(doctorLines(text.out).filter((l) => l.status === 'down')).toEqual([])
    expect([text.code, json.code]).toEqual([0, 0])
    expect(hashOf(two.dbPath), 'doctor wrote to the store').toBe(before)
  })

  it('AC-10: with seven dead events, the events line names the oldest five and says 2 more', async () => {
    const dead = deadOf(seven)
    expect(dead.length, 'the fixture').toBe(7)

    const line = eventsLine(await doctor(seven))

    expect(line?.status).toBe('warn')
    const named = dead.map((r) => line?.detail.includes(`seq ${r.seq} ${r.type} ${r.id}`) ?? false)
    expect(named).toEqual(dead.map((_, i) => i < 5))
    expect(line?.detail).toMatch(new RegExp(`\\b${dead.length - 5} more\\b`))
  })

  it('AC-10: events query --json prints each event’s attempts and deadAt as the log holds them, and leaves the database file unchanged', async () => {
    const before = hashOf(two.dbPath)
    const wanted = two.rows.filter((r) => r.attempts > 0)
    const printed = new Map<string, Record<string, unknown>>()
    for (const correlationId of new Set(wanted.map((r) => r.correlationId))) {
      const run = await runCli(['events', 'query', '--correlation', correlationId, '--json'], {
        cwd: two.project.dir,
        env: two.project.env,
      })
      expect(run.code, run.out.slice(-3000)).toBe(0)
      for (const l of stdoutLines(run.stdout)) {
        const parsed = JSON.parse(l) as Record<string, unknown>
        printed.set(String(parsed['id']), parsed)
      }
    }

    const instant = (v: unknown) =>
      v === null || v === undefined ? null : new Date(String(v)).getTime()
    expect(
      wanted.map((r) => ({
        attempts: printed.get(r.id)?.['attempts'],
        deadAt: instant(printed.get(r.id)?.['deadAt']),
      })),
    ).toEqual(wanted.map((r) => ({ attempts: r.attempts, deadAt: instant(r.deadAt) })))
    expect(wanted.map((r) => 'deadAt' in (printed.get(r.id) ?? {}))).toEqual(wanted.map(() => true))
    expect(hashOf(two.dbPath), 'events query wrote to the store').toBe(before)
  })
})
