import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cliEnv, MIGRATIONS_ROOT, REPO_ROOT, runCli } from '../../../../tests/support/doctor.js'
import {
  startWooCommerceServer,
  type WooCommerceServer,
} from '../../../../tests/support/woocommerce-server.js'

// Acceptance test for P3-01 AC-4, the import (spec P3-01-event-log-surface, decision 5): one `nymbal import` run
// publishes every event it causes under one id, `import:woocommerce:<uuidv7>`. The built CLI is spawned against the
// WooCommerce fixture server (tests/support/woocommerce-server.ts) on a fresh, migrated SQLite project, and the
// database file is read afterwards: a second platform copy in this process would not share the CLI's scope. Needs
// `pnpm build`. Kills: each imported event its own id (today).

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (
  path: string,
  options?: { readonly?: boolean },
) => {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}

const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const IMPORT_ID = new RegExp(`^import:woocommerce:${UUID_V7}$`)

let woo: WooCommerceServer
const dirs: string[] = []

beforeAll(async () => {
  woo = await startWooCommerceServer({ imagesPerProduct: 1 })
})

afterAll(async () => {
  await woo?.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p3-01-import-'))
  dirs.push(dir)
  const config = {
    store: { name: 'p3-01-import', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: { commandStore: 'sqlite', documentStore: 'in-memory', eventBus: 'in-process' },
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

describe('P3-01 AC-4: one id per import run', () => {
  it('AC-4: a `nymbal import` run (the CLI spawned, the database read afterwards) publishes every event under one import:woocommerce:<uuidv7>', async () => {
    const dir = project()
    const dbPath = join(dir, 'nymbal.db')
    const env = cliEnv({ NYMBAL_SQLITE_PATH: dbPath })

    const migrated = await runCli(['migrate'], { cwd: dir, env })
    expect(migrated.code, migrated.out.slice(-3000)).toBe(0)
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
        '--entities',
        'categories,products',
        '--no-ai',
      ],
      { cwd: dir, env, timeoutMs: 120_000 },
    )
    expect(imported.code, imported.out.slice(-3000)).toBe(0)

    const db = new BetterSqlite3(dbPath, { readonly: true })
    let rows: Array<{ type: string; envelope: string }>
    try {
      rows = db.prepare('SELECT type, envelope FROM events ORDER BY seq').all() as typeof rows
    } finally {
      db.close()
    }
    const ids = [
      ...new Set(
        rows.map((r) => (JSON.parse(r.envelope) as { correlationId: string }).correlationId),
      ),
    ]
    expect(
      rows.filter((r) => r.type === 'product.created.v1').length,
      'a product.created per imported product',
    ).toBeGreaterThanOrEqual(woo.products.length)

    expect(ids, `distinct correlation ids across the import's ${rows.length} events`).toHaveLength(
      1,
    )
    expect(IMPORT_ID.test(ids[0]!), ids[0]).toBe(true)
  }, 180_000)
})
