import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { freshState, loadState, type ImportEntity, type ImportState } from '@nymbalhq/importers'
import {
  buildRepositories,
  createCommandStore,
  createLogger,
  createNativeReviewsAdapter,
  InMemoryDocumentStore,
} from '@nymbalhq/platform'
import { cliEnv, MIGRATIONS_ROOT, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import {
  fixture,
  startWooCommerceServer,
  type WooCommerceServer,
} from '../../../../tests/support/woocommerce-server.js'
import {
  coveredTables,
  everyTable,
  readRows,
  type TableSnapshot,
} from '../../../../tests/support/store-tables.js'

// `nymbal import --rollback` through the built CLI (`pnpm build` first), against the WooCommerce fixture server on a
// SQLite project, the database read afterwards by a second connection: the import taken back out, what the rollback
// refuses, and the flags it will not combine with.

const ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders', 'reviews']
const STATE = '.nymbal-migration.json'
const JOURNAL = '.nymbal-migration.journal'
const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const ROLLBACK_ID = new RegExp(`^import-rollback:woocommerce:${UUID_V7}$`)
const REVIEWS = [100, 101].map((productId, i) => ({
  id: i + 1,
  product_id: productId,
  reviewer: `reviewer${i + 1}`,
  reviewer_email: `r${i + 1}@example.com`,
  review: 'from the old store',
  rating: 4 + i,
  verified: false,
  date_created: '2024-03-01T09:00:00',
}))

let woo: WooCommerceServer
const dirs: string[] = []

beforeAll(async () => {
  woo = await startWooCommerceServer({
    imagesPerProduct: 2,
    customers: fixture('customers'),
    orders: fixture('orders'),
    reviews: REVIEWS,
  })
})

afterAll(async () => {
  await woo?.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Project {
  dir: string
  dbPath: string
  statePath: string
  env: NodeJS.ProcessEnv
}

function project(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-import-'))
  dirs.push(dir)
  const config = {
    store: { name: 'rollback-import', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
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

function importArgs(...extra: string[]): string[] {
  return [
    'import',
    '--source',
    'woocommerce',
    '--url',
    woo.url,
    '--key',
    'k',
    '--secret',
    's',
    '--entities',
    ENTITIES.join(','),
    '--no-ai',
    ...extra,
  ]
}

/** A file's SHA-256, or `absent`. */
function fileState(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent'
}

/** Each covered table's rows now against `before`, one table at a time. */
function expectTablesAsBefore(before: TableSnapshot, after: TableSnapshot): void {
  expect(Object.keys(after)).toEqual(Object.keys(before))
  for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table])
}

/**
 * The count in the line `<label>: <n>` (the import's summary and the rollback's plan print their counts so), not a
 * progress line's `<label>: <done>/<total>`.
 */
function countAfter(out: string, label: string): number | undefined {
  const m = new RegExp(`^\\W*${label}:\\s*(\\d+)(?![\\d/])`, 'im').exec(out)
  return m === null ? undefined : Number(m[1])
}

/** The count in the rollback's `<Entity>: <n> removed` line. */
function removedCount(out: string, entity: string): number | undefined {
  const m = new RegExp(`^\\W*${entity}:\\s*(\\d+) removed`, 'im').exec(out)
  return m === null ? undefined : Number(m[1])
}

const capital = (e: string) => e[0]!.toUpperCase() + e.slice(1)

interface EventRow {
  seq: number
  type: string
  envelope: string
  correlation_id: string
}

/** The event log without the relay's delivery bookkeeping: what each event says, which history never rewrites. */
function eventsOf(dbPath: string): EventRow[] {
  return readRows<EventRow>(
    dbPath,
    'SELECT seq, id, type, envelope, correlation_id, created_at, subject_type, subject_id FROM events ORDER BY seq',
  )
}

interface AuditRow {
  id: string
  actor_kind: string
  actor_id: string
  outcome: string
  subjects: string
}

const auditOf = (dbPath: string) =>
  readRows<AuditRow>(dbPath, 'SELECT * FROM audit_entries ORDER BY at, id')

describe('an import taken back out with --rollback --yes', () => {
  const p = {} as Project
  let seeded: CliRun
  let imported: CliRun
  let beforeImport: TableSnapshot
  let afterImport: TableSnapshot
  let state: ImportState
  let mediaUrls: number
  let eventsAfterImport: EventRow[]
  let auditAfterImport: AuditRow[]
  let unconfirmed: CliRun
  let afterUnconfirmed: TableSnapshot
  let rolledBack: CliRun
  let afterRollback: TableSnapshot
  let everyAfterRollback: TableSnapshot
  let again: CliRun

  beforeAll(async () => {
    Object.assign(p, project())
    seeded = await nymbal(p, ['seed'])
    beforeImport = coveredTables(p.dbPath)
    imported = await nymbal(p, importArgs())
    state = (await loadState(p.statePath))!
    const products = new Set(state.importedIds.products)
    mediaUrls = readRows<{ id: string; media: string }>(p.dbPath, 'SELECT id, media FROM products')
      .filter((r) => products.has(r.id))
      .reduce((n, r) => n + (JSON.parse(r.media) as unknown[]).length, 0)
    afterImport = coveredTables(p.dbPath)
    eventsAfterImport = eventsOf(p.dbPath)
    auditAfterImport = auditOf(p.dbPath)

    unconfirmed = await nymbal(p, ['import', '--rollback'])
    afterUnconfirmed = coveredTables(p.dbPath)

    rolledBack = await nymbal(p, ['import', '--rollback', '--yes'])
    afterRollback = coveredTables(p.dbPath)
    everyAfterRollback = everyTable(p.dbPath)

    again = await nymbal(p, ['import', '--rollback', '--yes'])
  }, 600_000)

  it('AC-2: with no source flags it exits 0, every covered table is as it was before the import, each entity’s removed count is the import’s, Media kept counts the removed products’ image URLs, and the state file and journal are gone', () => {
    expect(
      [seeded.code, imported.code],
      seeded.out.slice(-2000) + imported.out.slice(-2000),
    ).toEqual([0, 0])
    expect(rolledBack.code, rolledBack.out.slice(-3000)).toBe(0)

    expectTablesAsBefore(beforeImport, afterRollback)
    for (const e of ENTITIES) {
      expect([e, removedCount(rolledBack.out, capital(e))]).toEqual([
        e,
        state.importedIds[e].length,
      ])
    }
    for (const e of ['categories', 'products', 'customers', 'orders'] as const) {
      expect([e, removedCount(rolledBack.out, capital(e))]).toEqual([
        e,
        countAfter(imported.out, capital(e)),
      ])
    }
    expect(rolledBack.out).toMatch(
      new RegExp(`Media kept: ${mediaUrls} image URLs \\(not deleted from storage\\)`),
    )
    expect(countAfter(rolledBack.out, 'Linked customers kept')).toBe(
      Object.values(state.wcToNymbalCustomer).filter(
        (id) => !state.importedIds.customers.includes(id),
      ).length,
    )
    expect([fileState(p.statePath), fileState(join(p.dir, JOURNAL))]).toEqual(['absent', 'absent'])
  })

  it('AC-8: every event and audit entry written before the rollback is there unchanged; every event the rollback publishes carries one import-rollback:woocommerce:<uuidv7>; its audit entries are import:woocommerce, applied, and name every record it removed', () => {
    const eventsNow = eventsOf(p.dbPath)
    const auditNow = auditOf(p.dbPath)
    const lastSeq = eventsAfterImport.at(-1)?.seq ?? 0

    expect(eventsNow.slice(0, eventsAfterImport.length)).toEqual(eventsAfterImport)
    const kept = new Set(auditAfterImport.map((a) => JSON.stringify(a)))
    expect(auditNow.filter((a) => kept.has(JSON.stringify(a))).length).toBe(auditAfterImport.length)

    const published = eventsNow.filter((e) => e.seq > lastSeq)
    const ids = [...new Set(published.map((e) => e.correlation_id))]
    expect(ids.length, `correlation ids over the rollback's ${published.length} events`).toBe(1)
    expect(ids[0]).toMatch(ROLLBACK_ID)

    const written = auditNow.filter((a) => !kept.has(JSON.stringify(a)))
    expect(written.map((a) => `${a.actor_kind}:${a.actor_id}:${a.outcome}`)).toEqual(
      written.map(() => 'import:woocommerce:applied'),
    )
    const named = new Set(
      written.flatMap((a) => (JSON.parse(a.subjects) as Array<{ id: string }>).map((s) => s.id)),
    )
    const removed = ENTITIES.flatMap((e) => state.importedIds[e])
    expect(removed.filter((id) => !named.has(id))).toEqual([])
    expect(removed.length).toBeGreaterThan(ENTITIES.length)
  })

  it('AC-13: without a TTY, --rollback without --yes exits 1, prints the plan’s count for each entity and removes nothing', () => {
    expect(unconfirmed.code, unconfirmed.out.slice(-3000)).toBe(1)
    for (const e of ENTITIES) {
      expect([e, countAfter(unconfirmed.out, capital(e))]).toEqual([e, state.importedIds[e].length])
    }
    expectTablesAsBefore(afterImport, afterUnconfirmed)
  })

  it('AC-5: after a complete rollback, --rollback exits 1 naming no-state and writes nothing', () => {
    expect(again.code, again.out.slice(-3000)).toBe(1)
    expect(again.out).toMatch(/no-state/)
    expectTablesAsBefore(everyAfterRollback, everyTable(p.dbPath))
    expect([fileState(p.statePath), fileState(join(p.dir, JOURNAL))]).toEqual(['absent', 'absent'])
  })
})

describe('AC-6: a store with activity of its own', () => {
  it('AC-6: a review submitted after the import makes --rollback --yes exit 1 naming live-store and the one review, and no table changes', async () => {
    const p = project()
    expect((await nymbal(p, ['migrate'])).code).toBe(0)
    const imported = await nymbal(p, importArgs())
    expect(imported.code, imported.out.slice(-3000)).toBe(0)
    const [productId] = (await loadState(p.statePath))!.importedIds.products

    // The command store reads only these of the config.
    const minimal = {
      infrastructure: { commandStore: 'sqlite' },
      store: { name: 'rollback-import', currency: 'GBP' },
    } as unknown as NymbalConfig
    const store = createCommandStore(minimal, { sqlitePath: p.dbPath })
    const documents = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    try {
      const reviews = createNativeReviewsAdapter({
        repos: buildRepositories(store, documents),
        logger: createLogger({ pretty: false, level: 'silent' }),
      })
      await reviews.submitReview({
        productId: productId!,
        customerId: null,
        author: null,
        orderId: null,
        rating: 5,
        title: '',
        body: 'bought after the import',
      })
    } finally {
      await documents.close()
      await store.close()
    }
    const before = everyTable(p.dbPath)

    const refused = await nymbal(p, ['import', '--rollback', '--yes'])

    expect(refused.code, refused.out.slice(-3000)).toBe(1)
    expect(refused.out).toMatch(/live-store/)
    expect(refused.out).toMatch(/\b1\b[^\n]*review|review[^\n]*\b1\b/i)
    expectTablesAsBefore(before, everyTable(p.dbPath))
  }, 300_000)
})

describe('AC-10: a state file that cannot be read', () => {
  const whole = JSON.stringify(freshState(), null, 2)
  const unreadable = [
    { name: 'truncated JSON', body: whole.slice(0, Math.floor(whole.length / 2)) },
    { name: '{} without importedIds', body: '{}' },
  ]

  for (const { name, body } of unreadable) {
    it(`AC-10: with ${name} at ${STATE}, nymbal import, import --fresh and import --rollback each exit 1 naming the file, and neither the store nor the state changes`, async () => {
      const p = project()
      expect((await nymbal(p, ['migrate'])).code).toBe(0)
      writeFileSync(p.statePath, body)
      const state = fileState(p.statePath)

      for (const args of [importArgs(), importArgs('--fresh'), ['import', '--rollback', '--yes']]) {
        const before = everyTable(p.dbPath)

        const run = await nymbal(p, args)

        const label = args.includes('--rollback')
          ? 'import --rollback'
          : args.includes('--fresh')
            ? 'import --fresh'
            : 'import'
        expect([label, run.code], run.out.slice(-3000)).toEqual([label, 1])
        expect(run.out, label).toContain(STATE)
        expectTablesAsBefore(before, everyTable(p.dbPath))
        expect([label, fileState(p.statePath), fileState(join(p.dir, JOURNAL))]).toEqual([
          label,
          state,
          'absent',
        ])
      }
    }, 600_000)
  }
})

describe('AC-13: flags --rollback will not combine with', () => {
  for (const conflict of [['--dry-run'], ['--since', '2026-10-01T00:00:00Z'], ['--fresh']]) {
    it(`AC-13: --rollback with ${conflict[0]} exits 1 naming both flags, before the store is opened`, async () => {
      const p = project()

      const run = await nymbal(p, ['import', '--rollback', '--yes', ...conflict])

      expect(run.code, run.out.slice(-3000)).toBe(1)
      expect([run.out.includes('--rollback'), run.out.includes(conflict[0]!)]).toEqual([true, true])
      expect(fileState(p.dbPath)).toBe('absent')
    }, 120_000)
  }
})
