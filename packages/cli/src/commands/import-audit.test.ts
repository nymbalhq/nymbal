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

// AC-3: a `nymbal import` run is audited as `import:woocommerce`, against the WooCommerce fixture server on a fresh
// SQLite project. Needs `pnpm build`.

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (
  path: string,
  options?: { readonly?: boolean },
) => {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}

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
  const dir = mkdtempSync(join(tmpdir(), 'audit-import-'))
  dirs.push(dir)
  const config = {
    store: { name: 'audit-import', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
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

function read<T>(dbPath: string, sql: string): T[] {
  const db = new BetterSqlite3(dbPath, { readonly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

describe('AC-3: an import run is attributed to import:woocommerce', () => {
  it('AC-3: every audit entry a `nymbal import` run writes is by import:woocommerce, applied, and their subjects name every product it created', async () => {
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

    const products = read<{ id: string }>(dbPath, 'SELECT id FROM products')
    expect(products.length, 'products the import created').toBeGreaterThanOrEqual(
      woo.products.length,
    )
    const entries = read<{
      actor_kind: string
      actor_id: string
      outcome: string
      subjects: string
    }>(dbPath, 'SELECT actor_kind, actor_id, outcome, subjects FROM audit_entries ORDER BY at, id')
    const named = new Set(
      entries.flatMap((e) => (JSON.parse(e.subjects) as Array<{ id: string }>).map((s) => s.id)),
    )

    expect(entries.length, 'entries the import wrote').toBeGreaterThan(0)
    expect(entries.map((e) => `${e.actor_kind}:${e.actor_id}:${e.outcome}`)).toEqual(
      entries.map(() => 'import:woocommerce:applied'),
    )
    expect(products.map((p) => p.id).filter((id) => !named.has(id))).toEqual([])
  }, 180_000)
})
