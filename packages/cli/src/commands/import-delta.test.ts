import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freshState, loadState, type FinishedPass, type ImportEntity } from '@nymbalhq/importers'
import { cliEnv, MIGRATIONS_ROOT, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { readRows } from '../../../../tests/support/store-tables.js'
import {
  fixture,
  startWooCommerceServer,
  type WooCommerceServer,
} from '../../../../tests/support/woocommerce-server.js'

// `nymbal import --since` through the built CLI (`pnpm build` first), against the WooCommerce fixture server on a
// SQLite project: what it refuses before it opens the store or asks WooCommerce anything, and a delta after an import
// as the merchant sees it in the outro and the migration report.

const STATE = '.nymbal-migration.json'
const DEFAULT_ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders']
/** After every `--since` these tests use. */
const CHANGED_AT = '2099-01-01T00:00:00'

const servers: WooCommerceServer[] = []
const dirs: string[] = []

async function server(): Promise<WooCommerceServer> {
  const woo = await startWooCommerceServer({
    imagesPerProduct: 1,
    customers: fixture('customers'),
    orders: fixture('orders'),
  })
  servers.push(woo)
  return woo
}

let woo: WooCommerceServer

beforeAll(async () => {
  woo = await server()
})

afterAll(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Project {
  dir: string
  dbPath: string
  statePath: string
  env: NodeJS.ProcessEnv
}

function project(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'delta-import-'))
  dirs.push(dir)
  const config = {
    store: { name: 'delta-import', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native', config: { transport: 'console' } },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3999, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  }
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  symlinkSync(MIGRATIONS_ROOT, join(dir, 'migrations'), 'dir')
  const dbPath = join(dir, 'nymbal.db')
  return { dir, dbPath, statePath: join(dir, STATE), env: cliEnv({ NYMBAL_SQLITE_PATH: dbPath }) }
}

function nymbal(p: Project, args: string[]): Promise<CliRun> {
  return runCli(args, { cwd: p.dir, env: p.env, timeoutMs: 120_000 })
}

function importArgs(at: WooCommerceServer, ...extra: string[]): string[] {
  return [
    'import',
    '--source',
    'woocommerce',
    '--url',
    at.url,
    '--key',
    'k',
    '--secret',
    's',
    '--no-ai',
    ...extra,
  ]
}

/** A file's SHA-256, or `absent`. */
function fileState(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent'
}

/** The count in the line `<label>: <n>`, not a progress line's `<label>: <done>/<total>`. */
function countAfter(out: string, label: string): number | undefined {
  const m = new RegExp(`^\\W*${label}:\\s*(\\d+)(?![\\d/])`, 'im').exec(out)
  return m === null ? undefined : Number(m[1])
}

/** A state whose import pass finished, covering the default entities. */
function finishedState(): string {
  const startedAt = '2026-10-20T08:15:42.678Z'
  return JSON.stringify({
    ...freshState(),
    startedAt,
    rollbackSince: startedAt,
    phase: 'done',
    runs: [{ startedAt, finishedAt: '2026-10-20T08:40:00.000Z', entities: DEFAULT_ENTITIES }],
  })
}

/** A state whose import pass stopped on products. */
function unfinishedState(): string {
  return JSON.stringify({ ...freshState(), phase: 'products', runs: [] })
}

describe('AC-4: what nymbal import --since refuses', () => {
  const cases: Array<{
    name: string
    state: string | null
    extra: string[]
    names: Array<string | RegExp>
  }> = [
    {
      name: 'an invalid value',
      state: finishedState(),
      extra: ['--since', 'yesterday'],
      names: ['yesterday'],
    },
    {
      name: 'a date-time with no zone',
      state: finishedState(),
      extra: ['--since', '2026-10-01T10:00:00'],
      names: ['2026-10-01T10:00:00'],
    },
    {
      name: 'last with no finished pass',
      state: unfinishedState(),
      extra: ['--since', 'last'],
      names: ['nymbal import'],
    },
    { name: 'no state', state: null, extra: ['--since', '2026-10-01'], names: [/no-state|\.nymbal-migration\.json/] },
    {
      name: 'a date on an unfinished pass',
      state: unfinishedState(),
      extra: ['--since', '2026-10-01'],
      names: ['nymbal import'],
    },
    {
      name: '--fresh',
      state: finishedState(),
      extra: ['--since', 'last', '--fresh'],
      names: ['--since', '--fresh'],
    },
    {
      name: '--dry-run',
      state: finishedState(),
      extra: ['--since', 'last', '--dry-run'],
      names: ['--since', '--dry-run'],
    },
  ]

  for (const c of cases) {
    it(`AC-4: --since with ${c.name} exits 1 naming it, before the store is opened, with no request to WooCommerce and the state file as it was`, async () => {
      // Not migrated: a command that opens the store creates the database file.
      const p = project()
      if (c.state !== null) writeFileSync(p.statePath, c.state)
      const before = fileState(p.statePath)
      woo.requests.length = 0

      const run = await nymbal(p, importArgs(woo, ...c.extra))

      expect(run.code, run.out.slice(-3000)).toBe(1)
      expect(
        c.names.filter((n) => (typeof n === 'string' ? !run.out.includes(n) : !n.test(run.out))),
      ).toEqual([])
      expect(woo.requests.map((r) => r.path)).toEqual([])
      expect([fileState(p.statePath), fileState(p.dbPath)]).toEqual([before, 'absent'])
    }, 120_000)
  }
})

describe('AC-10: a delta through the CLI', () => {
  it('AC-10: after nymbal import and a change to one product’s name and price and to one order, nymbal import --since last exits 0, applies the product, prints Updated products: 1 and Changed orders not updated: 1, and the report has ## Changes since with each entity’s since and both counts', async () => {
    const source = await server()
    const p = project()
    const migrated = await nymbal(p, ['migrate'])
    const imported = await nymbal(p, importArgs(source))
    expect([migrated.code, imported.code], migrated.out.slice(-2000) + imported.out.slice(-3000)).toEqual([0, 0])
    const afterImport = (await loadState(p.statePath)) as { runs: FinishedPass[] }
    const newPriceMinor = 3150
    const at = source.source.products.findIndex((r) => r['id'] === 100)
    source.source.products[at] = {
      ...source.source.products[at],
      name: 'Classic White Tee, renamed',
      regular_price: (newPriceMinor / 100).toFixed(2),
      date_modified_gmt: CHANGED_AT,
    }
    source.source.orders[0] = {
      ...source.source.orders[0],
      status: 'cancelled',
      date_modified_gmt: CHANGED_AT,
    }

    const delta = await nymbal(p, importArgs(source, '--since', 'last'))

    expect(delta.code, delta.out.slice(-3000)).toBe(0)
    expect([
      countAfter(delta.out, 'Updated products'),
      countAfter(delta.out, 'Changed orders not updated'),
    ]).toEqual([1, 1])
    expect(
      readRows<{ name: string; price: number }>(
        p.dbPath,
        `SELECT p.name AS name, v.price_minor AS price FROM products p JOIN variants v ON v.product_id = p.id
         WHERE p.slug = 'classic-white-tee'`,
      ),
    ).toEqual([{ name: 'Classic White Tee, renamed', price: newPriceMinor }])
    const report = readFileSync(join(p.dir, 'nymbal-migration-report.md'), 'utf8')
    const from = report.indexOf('## Changes since')
    expect(from, report).not.toBe(-1)
    const rest = report.slice(from + 1)
    const section = rest
      .slice(0, rest.includes('\n## ') ? rest.indexOf('\n## ') : undefined)
      .split('\n')
    const since = `${new Date(afterImport.runs[0]!.startedAt).toISOString().slice(0, 19)}Z`
    const line = (...words: RegExp[]) => section.filter((l) => words.every((w) => w.test(l))).length
    expect([
      line(/products/i, new RegExp(since)),
      line(/orders/i, new RegExp(since)),
      line(/updated/i, /product/i, /\b1\b/),
      line(/order/i, /not updated|changed/i, /\b1\b/),
    ]).toEqual([1, 1, 1, 1])
    // The delta's pass is recorded, and each entity's since is the start of the pass before it, to the second.
    const afterDelta = (await loadState(p.statePath)) as { runs: FinishedPass[] }
    expect(afterDelta.runs.length).toBe(afterImport.runs.length + 1)
    const importStartSecond = Math.floor(Date.parse(afterImport.runs.at(-1)!.startedAt) / 1000) * 1000
    const sinceByEntity = afterDelta.runs.at(-1)!.since ?? {}
    expect(DEFAULT_ENTITIES.map((e) => Date.parse(sinceByEntity[e] ?? ''))).toEqual(
      DEFAULT_ENTITIES.map(() => importStartSecond),
    )
  }, 300_000)
})
