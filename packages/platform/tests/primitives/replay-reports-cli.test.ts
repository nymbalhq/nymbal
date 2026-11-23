import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cliEnv, runCli, type CliRun } from '../../../../tests/support/doctor'
import { createKernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { QUIET_RELAY, logEvents, processedCount, reportRows } from '../support/report-rebuild.js'
import {
  ROLLUP_TABLES,
  addDays,
  events,
  noonOf,
  seedPool,
  storeDay,
} from '../support/report-rollups.js'

// `nymbal replay --to reports`, the built CLI against a SQLite store whose document store is in-memory: the report
// tables live in the command store, so the in-memory refusal does not apply to them. Each case reads the outcome from
// the file, never from what the command says it did. Needs `pnpm build`.

const dir = mkdtempSync(join(tmpdir(), 'replay-reports-cli-'))
const dbPath = join(dir, 'store.sqlite')
let projectDir: string
let raw: RawReader
let heldFrom: string

const replay = (...args: string[]): Promise<CliRun> =>
  runCli(['replay', ...args], { cwd: projectDir, env: cliEnv({ NYMBAL_SQLITE_PATH: dbPath }) })

const token = (text: string) => new RegExp(`(?<![\\w.-])${text.replace(/[-]/g, '\\-')}(?![\\w.-])`)

/** Whether a line of `out` names `name` and the number `n`, each as a word of its own. */
function lineWith(out: string, name: string, n: number): boolean {
  return out.split('\n').some((line) => token(name).test(line) && token(String(n)).test(line))
}

function emptyReports(): void {
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    for (const table of ROLLUP_TABLES) db.prepare(`DELETE FROM ${table}`).run()
  } finally {
    db.close()
  }
}

/** Rows per report table on the held days, as the file holds them. */
async function heldRows(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of ROLLUP_TABLES)
    out[table] = await raw.count(table, 'local_day >= ?', [heldFrom])
  return out
}

beforeAll(async () => {
  const k = await createKernel({ dialect: 'sqlite', sqlitePath: dbPath, appOptions: QUIET_RELAY })
  try {
    const pool = await seedPool(k)
    await k.app.relay.drain()
    const today = storeDay(new Date())
    const gbp = pool.orders.find((o) => o.currency === 'GBP' && o.source === 'storefront')!
    // The oldest append is the floor: its day is partial, the held days start the day after.
    const oldest = events.captured(gbp, 900, noonOf(addDays(today, -6)))
    await logEvents(k, [
      { event: oldest, state: 'delivered', live: true },
      {
        event: events.captured(gbp, 1_500, noonOf(addDays(today, -4))),
        state: 'delivered',
        live: true,
      },
      { event: events.paid(gbp, noonOf(addDays(today, -4))), state: 'delivered', live: true },
      {
        event: events.viewed('cli-viewer', noonOf(addDays(today, -3))),
        state: 'delivered',
        live: true,
      },
      { event: events.searched('cli term', noonOf(addDays(today, -2))), state: 'delivered' },
    ])
    heldFrom = addDays(storeDay(new Date(oldest.timestamp)), 1)
    const { config } = k
    projectDir = mkdtempSync(join(dir, 'project-'))
    writeFileSync(
      join(projectDir, 'nymbal.config.ts'),
      `export default ${JSON.stringify(config, null, 2)}\n`,
    )
  } finally {
    await k.close()
  }
  raw = openRaw('sqlite', dbPath)
}, 120_000)

afterAll(async () => {
  await raw?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('AC-9: nymbal replay --to reports on an in-memory document store', () => {
  it('AC-9: --to nope exits 2 and names reports among the choices', async () => {
    const run = await replay('--to', 'nope')

    expect(run.code, run.out).toBe(2)
    expect(run.out).toMatch(token('reports'))
  })

  it('AC-9: --to reports exits 0, prints the held days, and names each report table with the rows its held days now hold', async () => {
    const run = await replay('--to', 'reports')

    expect(run.code, run.out).toBe(0)
    expect(run.out).toMatch(token(heldFrom))
    expect(run.out).toMatch(token(storeDay(new Date())))
    const held = await heldRows()
    expect(held['report_sales_hours'], 'the held days hold sales').toBeGreaterThanOrEqual(1)
    for (const table of ROLLUP_TABLES) {
      expect(lineWith(run.out, table, held[table]!), `${table} ${held[table]}\n${run.out}`).toBe(
        true,
      )
    }
  })

  it('AC-9: --dry-run exits 1 on a store whose report tables were emptied and writes nothing; after a rebuild it exits 0', async () => {
    emptyReports()
    const claims = await processedCount(raw)

    const dry = await replay('--to', 'reports', '--dry-run')

    expect(dry.code, dry.out).toBe(1)
    expect(await heldRows()).toEqual(Object.fromEntries(ROLLUP_TABLES.map((t) => [t, 0])))
    expect(await processedCount(raw)).toBe(claims)

    const run = await replay('--to', 'reports')
    const again = await replay('--to', 'reports', '--dry-run')

    expect(run.code, run.out).toBe(0)
    expect(again.code, again.out).toBe(0)
  })

  it('AC-9: --to all is refused on an in-memory document store and leaves the report tables as they were; --to reports then fills them', async () => {
    emptyReports()
    const before = await reportRows(raw)

    const all = await replay('--to', 'all')

    expect(all.code, all.out).toBe(2)
    expect(all.out).toMatch(/infrastructure\.documentStore 'in-memory'/)
    expect(await reportRows(raw), all.out).toEqual(before)

    const run = await replay('--to', 'reports')

    expect(run.code, run.out).toBe(0)
    const held = await heldRows()
    expect(held['report_sales_hours']).toBeGreaterThan(before['report_sales_hours']!.length)
  })
})
