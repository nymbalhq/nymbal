import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { createCommandStore, rawClients } from '@nymbalhq/platform'
import {
  cliEnv,
  MIGRATIONS_ROOT,
  runCli,
  stripAnsi,
  type CliRun,
} from '../../../../tests/support/doctor.js'
import {
  fixture,
  startWooCommerceServer,
  type WooCommerceServer,
} from '../../../../tests/support/woocommerce-server.js'
import { openStoreReadOnly } from './import-plan.js'

// `nymbal import --dry-run` through the built CLI (`pnpm build` first), against the WooCommerce fixture server. The
// populated project is seeded (the demo catalogue's `books`) and then holds the fixture source from a real import, so
// that every kind of record the source sends is already in the store when the dry-run reads it.

const KEY = 'ck_dryrun_3f9a1c7e5b2d4086'
const SECRET = 'cs_dryrun_8e2a4c6f1b3d5097'
const ENTITIES = ['categories', 'products', 'customers', 'orders'] as const
const PLAN_JSON = 'nymbal-import-plan.json'
const PLAN_MD = 'nymbal-import-plan.md'
const IMPORT_LEFTOVERS = [
  '.nymbal-migration.json',
  '.nymbal-migration.journal',
  'nymbal-migration-report.md',
  join('public', 'imported-media'),
]

interface PlanFile {
  counts: Record<string, { source: number; import: number; refused: number; skipped: number }>
  unmapped: Record<string, unknown>
  collisions: Array<{
    kind: string
    with: 'source' | 'store'
    value: string
    sourceIds: string[]
    outcome: 'refused' | 'links-existing'
  }>
  estimate: Record<string, unknown>
  existingStore: 'checked' | { notChecked: string }
  [key: string]: unknown
}

let woo: WooCommerceServer
const dirs: string[] = []

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dry-run-import-'))
  dirs.push(dir)
  const config = {
    store: { name: 'dry-run-import', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
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
  return dir
}

function dryRun(dir: string, env: NodeJS.ProcessEnv): Promise<CliRun> {
  return runCli(
    [
      'import',
      '--dry-run',
      '--source',
      'woocommerce',
      '--url',
      woo.url,
      '--key',
      KEY,
      '--secret',
      SECRET,
    ],
    { cwd: dir, env, timeoutMs: 120_000 },
  )
}

/** A file's SHA-256, `empty` for a zero-length file, `absent` for none. */
function stateOf(path: string): string {
  if (!existsSync(path)) return 'absent'
  const bytes = readFileSync(path)
  return bytes.length === 0 ? 'empty' : createHash('sha256').update(bytes).digest('hex')
}

function readPlan(dir: string): PlanFile {
  return JSON.parse(readFileSync(join(dir, PLAN_JSON), 'utf8')) as PlanFile
}

beforeAll(async () => {
  woo = await startWooCommerceServer({
    imagesPerProduct: 1,
    extraCategories: [
      { id: 12, name: 'Books', slug: 'books', parent: 0, description: '', count: 0 },
    ],
    customers: fixture('customers'),
    orders: fixture('orders'),
  })
})

afterAll(async () => {
  await woo?.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('a dry-run against a store that already holds the source', () => {
  let dir: string
  let dbPath: string
  let before: { db: string; wal: string }
  let run: CliRun

  beforeAll(async () => {
    dir = project()
    dbPath = join(dir, 'nymbal.db')
    const env = cliEnv({ NYMBAL_SQLITE_PATH: dbPath })

    const seeded = await runCli(['seed'], { cwd: dir, env, timeoutMs: 120_000 })
    expect(seeded.code, seeded.out.slice(-3000)).toBe(0)
    const imported = await runCli(
      [
        'import',
        '--source',
        'woocommerce',
        '--url',
        woo.url,
        '--key',
        'k',
        '--secret',
        's',
        '--no-ai',
      ],
      { cwd: dir, env, timeoutMs: 120_000 },
    )
    expect(imported.code, imported.out.slice(-3000)).toBe(0)
    for (const leftover of IMPORT_LEFTOVERS)
      rmSync(join(dir, leftover), { recursive: true, force: true })

    before = { db: stateOf(dbPath), wal: stateOf(`${dbPath}-wal`) }
    woo.requests.length = 0
    run = await dryRun(dir, env)
  }, 300_000)

  it('AC-2: the store file is byte for byte unchanged, no import state, report or media appears, and the source saw only GETs under /wp-json/wc/v3/', () => {
    expect(run.code, run.out.slice(-3000)).toBe(0)

    // A read-only open of a WAL database may leave an empty -wal and the -shm index behind: neither holds a row.
    const wal = stateOf(`${dbPath}-wal`)
    expect({
      db: stateOf(dbPath),
      wal: before.wal === 'absent' && wal === 'empty' ? 'absent' : wal,
    }).toEqual(before)
    expect(IMPORT_LEFTOVERS.filter((p) => existsSync(join(dir, p)))).toEqual([])

    const offApi = woo.requests.filter(
      (r) => r.method !== 'GET' || !r.path.startsWith('/wp-json/wc/v3/'),
    )
    expect(offApi).toEqual([])
    expect(woo.requests.map((r) => r.path)).toContain('/wp-json/wc/v3/products')
  })

  it('AC-5: the written plan holds a category-slug, product-slug, sku and order-number collision with the store, and counts move the refused records out of import', () => {
    expect(existsSync(join(dir, PLAN_JSON)), run.out.slice(-3000)).toBe(true)
    const plan = readPlan(dir)
    const store = plan.collisions.filter((c) => c.with === 'store')
    const valuesOf = (kind: string) =>
      store
        .filter((c) => c.kind === kind)
        .map((c) => c.value)
        .sort()
    const servedCategories = [...fixture('categories'), { slug: 'books' }].map(
      (c) => c['slug'] as string,
    )

    expect({
      categories: valuesOf('category-slug'),
      products: valuesOf('product-slug'),
      orders: valuesOf('order-number'),
    }).toEqual({
      categories: servedCategories.sort(),
      products: woo.products.map((p) => p.slug).sort(),
      orders: fixture('orders').map((o) => `WC-${o['number'] as string}`),
    })
    // The store holds every served SKU: each sku clash names one of them, and there is at least one.
    const servedSkus = [
      ...fixture('products').map((p) => p['sku'] as string),
      ...fixture('variations').map((v) => v['sku'] as string),
    ]
    expect(valuesOf('sku').filter((sku) => !servedSkus.includes(sku))).toEqual([])
    expect(valuesOf('sku').length).toBeGreaterThan(0)
    expect(store.filter((c) => c.kind !== 'customer-email').map((c) => c.outcome)).toEqual(
      store.filter((c) => c.kind !== 'customer-email').map(() => 'refused'),
    )
    expect(plan.existingStore).toBe('checked')

    const phase: Record<string, string> = {
      'category-slug': 'categories',
      'product-slug': 'products',
      sku: 'products',
      'order-number': 'orders',
    }
    for (const e of ['categories', 'products', 'orders']) {
      const refused = new Set(
        plan.collisions
          .filter((c) => c.outcome === 'refused' && phase[c.kind] === e)
          .flatMap((c) => c.sourceIds),
      )
      const c = plan.counts[e]!
      expect([e, c.refused], e).toEqual([e, refused.size])
      expect([e, c.import + c.refused + c.skipped], e).toEqual([e, c.source])
    }
  })

  it('AC-8: nymbal-import-plan.json holds every plan key and nymbal-import-plan.md the five sections in order', () => {
    expect(existsSync(join(dir, PLAN_JSON)), run.out.slice(-3000)).toBe(true)
    const plan = readPlan(dir)
    const md = readFileSync(join(dir, PLAN_MD), 'utf8')
    const sections = [
      '## Counts',
      '## Collisions',
      '## Unmapped fields',
      '## Estimate',
      "## Won't migrate",
    ]

    expect(Object.keys(plan).sort()).toEqual([
      'collisions',
      'counts',
      'estimate',
      'existingStore',
      'resumeStateFound',
      'source',
      'unmapped',
      'wontMigrate',
    ])
    expect(Object.keys(plan.counts).sort()).toEqual([
      'categories',
      'customers',
      'orders',
      'products',
      'reviews',
    ])
    expect(Object.keys(plan.unmapped).sort()).toEqual([
      'categories',
      'customers',
      'orders',
      'products',
      'reviews',
      'variations',
    ])
    expect(Object.keys(plan.estimate).sort()).toEqual([
      'meanRequestMs',
      'requests',
      'seconds',
      'writes',
    ])
    expect(md.split('\n').filter((line) => sections.includes(line.trim()))).toEqual(sections)
  })

  it("AC-8: stdout prints each selected entity's import / source as the plan file counts them", () => {
    expect(existsSync(join(dir, PLAN_JSON)), run.out.slice(-3000)).toBe(true)
    const plan = readPlan(dir)
    const lines = stripAnsi(run.stdout).split('\n')

    const printed = ENTITIES.map((e) => {
      const { import: imported, source } = plan.counts[e]!
      const pattern = new RegExp(`\\b${e}\\b.*\\b${imported}\\s*/\\s*${source}\\b`, 'i')
      return [e, lines.some((l) => pattern.test(l))]
    })
    expect(printed).toEqual(ENTITIES.map((e) => [e, true]))
  })

  it('AC-8: the consumer key and secret appear in neither plan file, nor in stdout or stderr', () => {
    expect(existsSync(join(dir, PLAN_JSON)), run.out.slice(-3000)).toBe(true)
    const basic = Buffer.from(`${KEY}:${SECRET}`).toString('base64')
    const texts = {
      json: readFileSync(join(dir, PLAN_JSON), 'utf8'),
      markdown: readFileSync(join(dir, PLAN_MD), 'utf8'),
      stdout: run.stdout,
      stderr: run.stderr,
    }

    const leaks = Object.entries(texts).flatMap(([where, text]) =>
      [KEY, SECRET, basic].filter((secret) => text.includes(secret)).map(() => where),
    )
    expect(leaks).toEqual([])
  })
})

describe('a dry-run with no database file', () => {
  it('AC-5: with no database file the plan is still written, existingStore names the path it did not find, the run exits 0 and creates no database', async () => {
    const dir = project()
    const dbPath = join(dir, 'nymbal.db')

    const run = await dryRun(dir, cliEnv({ NYMBAL_SQLITE_PATH: dbPath }))

    expect(run.code, run.out.slice(-3000)).toBe(0)
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(join(dir, PLAN_JSON)), run.out.slice(-3000)).toBe(true)
    const plan = readPlan(dir)
    const notChecked = typeof plan.existingStore === 'object' ? plan.existingStore.notChecked : ''
    expect(notChecked).toContain(dbPath)
    expect(plan.counts['products']!.source).toBe(woo.products.length)
  }, 180_000)
})

describe('the store a dry-run checks against', () => {
  it('AC-2: the store the dry-run opens refuses a write: SQLite answers attempt to write a readonly database', async () => {
    const dir = project()
    const dbPath = join(dir, 'nymbal.db')
    const config = { infrastructure: { commandStore: 'sqlite' } } as NymbalConfig
    await createCommandStore(config, { sqlitePath: dbPath }).close()
    vi.stubEnv('NYMBAL_SQLITE_PATH', dbPath)
    const store = openStoreReadOnly(config)
    vi.unstubAllEnvs()

    try {
      const clients = rawClients(store)
      if (clients.kind !== 'sqlite') throw new Error(`expected a SQLite store, got ${clients.kind}`)
      expect(() => clients.raw.exec('CREATE TABLE written (id INTEGER)')).toThrow(
        /attempt to write a readonly database/,
      )
    } finally {
      await store.close()
    }
  })
})

describe('a dry-run with an unknown entity', () => {
  it('--entities with a name outside the five exits 1 naming it and the valid ones, and writes no plan', async () => {
    const dir = project()
    const dbPath = join(dir, 'nymbal.db')
    const requestsBefore = woo.requests.length

    const run = await runCli(
      [
        'import',
        '--dry-run',
        '--source',
        'woocommerce',
        '--url',
        woo.url,
        '--key',
        KEY,
        '--secret',
        SECRET,
        '--entities',
        'categories,product',
      ],
      { cwd: dir, env: cliEnv({ NYMBAL_SQLITE_PATH: dbPath }), timeoutMs: 120_000 },
    )

    expect(run.code, run.out.slice(-3000)).toBe(1)
    const said = stripAnsi(run.stderr)
    expect(said).toMatch(/\bproduct\b(?!s)/)
    expect(
      ['categories', 'products', 'customers', 'orders', 'reviews'].filter((e) => !said.includes(e)),
    ).toEqual([])
    expect([PLAN_JSON, PLAN_MD].filter((f) => existsSync(join(dir, f)))).toEqual([])
    expect(woo.requests.length).toBe(requestsBefore)
  }, 180_000)
})
