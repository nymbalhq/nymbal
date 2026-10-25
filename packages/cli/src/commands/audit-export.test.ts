import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT, runCli } from '../../../../tests/support/doctor.js'
import { sqliteProject, stdoutLines } from '../../../../tests/support/events-cli.js'
import {
  activityEntries,
  adminSession,
  IDEMPOTENCY_KEY,
} from '../../../platform/tests/support/audit-http.js'
import { serveKernel } from '../../../platform/tests/support/http.js'
import { checkoutOf, createKernel, seedVariant } from '../../../platform/tests/support/kernel.js'

// AC-6: `nymbal audit export`, the built CLI against a SQLite store whose entries were made over HTTP either side of
// a time `t`, compared with what `GET /api/admin/activity` listed. The store is switched to a rollback journal so an
// export that writes leaves a trace. Needs `pnpm build`.

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (path: string) => {
  pragma(sql: string): unknown
  close(): void
}

type Entry = Record<string, unknown> & { id: string; at: string }

const dirs: string[] = []
let dbPath: string
let project: { dir: string; env: NodeJS.ProcessEnv }
let since: string
let listed: Entry[]
let keyedCorrelation: string
let correlated: Entry[]

let apiFailure: unknown

function failed(error: unknown): Entry[] {
  apiFailure ??= error
  return []
}

/** The activity API's entries, or the error it answered while the store was up. */
function api<T>(entries: T): T {
  if (apiFailure !== undefined) throw apiFailure
  return entries
}

const hashOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const byId = (entries: Entry[]) => [...entries].sort((a, b) => a.id.localeCompare(b.id))
const atOf = (entry: Entry) => Date.parse(entry.at)

/** Resolves once the clock has moved past `ms`, so the next write is stamped strictly later. */
async function pastMs(ms: number): Promise<void> {
  while (Date.now() <= ms) await new Promise((resolve) => setImmediate(resolve))
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-export-'))
  dirs.push(dir)
  dbPath = join(dir, 'nymbal.db')
  const kernel = await createKernel({ dialect: 'sqlite', sqlitePath: dbPath })
  const served = await serveKernel(kernel)
  try {
    const admin = await adminSession(kernel, served.baseUrl)
    const seeded = await seedVariant(kernel, 100)
    const adjust = (delta: number, headers: Record<string, string> = {}) =>
      admin.send(
        'POST',
        `/api/admin/inventory/${seeded.variantId}/adjust`,
        { delta, reason: 'manual' },
        headers,
      )

    // Before t: two adjusts and a product rename.
    for (const answer of [
      await adjust(1),
      await adjust(2),
      await admin.send('PATCH', `/api/admin/products/${seeded.productId}`, { name: 'Before' }),
    ]) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    }
    await pastMs(Date.now())
    since = new Date().toISOString()
    await pastMs(Date.parse(since))

    // After t: a keyed adjust and its replay, a refused transition, a rename.
    const key = `ac6.${randomUUID()}`
    const keyed = await adjust(3, { [IDEMPOTENCY_KEY]: key })
    const replay = await adjust(3, { [IDEMPOTENCY_KEY]: key })
    const order = await checkoutOf(kernel, seeded, 1)
    const refused = await admin.send('POST', `/api/admin/orders/${order.orderId}/mark-delivered`)
    const renamed = await admin.send('PATCH', `/api/admin/products/${seeded.productId}`, {
      name: 'After',
    })
    expect([keyed.status, replay.status, refused.status, renamed.status]).toEqual([
      200, 200, 409, 200,
    ])
    keyedCorrelation = keyed.correlationId!

    // The API's answer is what the export must equal; a missing route fails the tests that compare, not the setup.
    listed = (await activityEntries(admin).catch(failed)) as Entry[]
    correlated = (await activityEntries(admin, { correlation: keyedCorrelation }).catch(
      failed,
    )) as Entry[]
  } finally {
    await served.stop()
  }
  // A rollback journal: any write the command makes changes the file's bytes or leaves a -wal/-shm beside it.
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = DELETE')
  db.close()
  project = sqliteProject(dbPath)
  dirs.push(project.dir)
}, 90_000)

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function exportAudit(args: string[]) {
  return runCli(['audit', 'export', ...args], { cwd: project.dir, env: project.env })
}

const parsedLines = (stdout: string) => stdoutLines(stdout).map((l) => JSON.parse(l) as Entry)

// Each case spawns the built CLI, once or twice, and outlasts the 5 s default when other spawning suites run beside it.
describe('AC-6: nymbal audit export', { timeout: 20_000 }, () => {
  it('AC-6: --since <t> prints, as NDJSON in `at` order, exactly the entries the activity API lists from t on, equal to them, and leaves the store untouched', async () => {
    const hashBefore = hashOf(dbPath)
    const run = await exportAudit(['--since', since])
    expect(run.code, run.out.slice(-3000)).toBe(0)
    const lines = parsedLines(run.stdout)
    const expected = api(listed).filter((e) => atOf(e) >= Date.parse(since))
    expect(
      api(listed).length - expected.length,
      'the fixture: entries on both sides of t',
    ).toBeGreaterThanOrEqual(3)
    expect(expected.length, 'the fixture: entries on both sides of t').toBeGreaterThanOrEqual(4)

    expect(byId(lines)).toEqual(byId(expected))
    expect(lines.map(atOf)).toEqual(lines.map(atOf).sort((a, b) => a - b))
    expect(hashOf(dbPath), 'the store file’s bytes').toBe(hashBefore)
    expect(
      [`${dbPath}-wal`, `${dbPath}-shm`].filter((p) => existsSync(p)),
      'journal files left beside the store',
    ).toEqual([])
  })

  it('AC-6: --correlation <id> narrows the export to that request’s entries, and --out writes the same lines to a file', async () => {
    const out = join(project.dir, `audit-${randomUUID()}.ndjson`)
    const printed = await exportAudit(['--since', since, '--correlation', keyedCorrelation])
    const written = await exportAudit([
      '--since',
      since,
      '--correlation',
      keyedCorrelation,
      '--out',
      out,
    ])
    expect([printed.code, written.code], printed.out.slice(-2000)).toEqual([0, 0])

    expect(api(correlated).length, 'the fixture: the keyed adjust’s entries').toBeGreaterThan(0)
    expect(byId(parsedLines(printed.stdout))).toEqual(byId(correlated))
    expect(parsedLines(readFileSync(out, 'utf8'))).toEqual(parsedLines(printed.stdout))
  })

  it('AC-6: a --since that is not a time exits 2 and prints no entries', async () => {
    const runs = await Promise.all([
      exportAudit(['--since', 'not-a-time']),
      exportAudit(['--since', '2026-13-45T99:00:00Z']),
    ])

    expect(runs.map((r) => r.code)).toEqual(runs.map(() => 2))
    expect(runs.map((r) => stdoutLines(r.stdout).length)).toEqual(runs.map(() => 0))
  })
})
