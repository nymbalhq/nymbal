import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cliEnv, MIGRATIONS_ROOT, runCli } from '../../../../tests/support/doctor.js'
import { readRows } from '../../../../tests/support/store-tables.js'
import {
  startWooCommerceServer,
  type WooCommerceServer,
} from '../../../../tests/support/woocommerce-server.js'

// What `nymbal import` tells a merchant at the end, through the built CLI (`pnpm build` first) against the WooCommerce
// fixture server on a SQLite project whose ai provider is `none`: enrichment is said to be off, an image the source no
// longer serves is listed in the migration report under its phase, its product is still imported, and the outro's
// counts are the report's.

const servers: WooCommerceServer[] = []
const dirs: string[] = []

afterAll(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): { dir: string; dbPath: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'import-summary-'))
  dirs.push(dir)
  const config = {
    store: { name: 'import-summary', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
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
  return { dir, dbPath, env: cliEnv({ NYMBAL_SQLITE_PATH: dbPath }) }
}

/** The item lines under `heading` in the report, and each `### <Phase> (<n>)` heading's count, up to the next `## `. */
function section(
  report: string,
  heading: string,
): { items: string[]; counts: Record<string, number> } {
  const lines = report.split('\n')
  const start = lines.indexOf(heading)
  if (start < 0) return { items: [], counts: {} }
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  const body = lines.slice(start + 1, end < 0 ? lines.length : end)
  const counts: Record<string, number> = {}
  for (const l of body) {
    const m = /^### (.+) \((\d+)\)$/.exec(l)
    if (m) counts[m[1]!] = Number(m[2])
  }
  return { items: body.filter((l) => l.startsWith('- ')), counts }
}

describe('the end of nymbal import', () => {
  it('AC-3: with the ai provider none and one image gone from the source, the outro says enrichment is off instead of a count of 0, the product imports with its other images, the report lists the image under Media, and the outro’s error and review counts are the report’s', async () => {
    const woo = await startWooCommerceServer({ imagesPerProduct: 2 })
    servers.push(woo)
    const at = woo.source.products.findIndex((r) => r['id'] === 100)
    const listed = woo.source.products[at]!
    const missing = `${woo.url}/img/gone-100.jpg`
    woo.source.products[at] = {
      ...listed,
      images: [
        ...(listed['images'] as Array<Record<string, unknown>>),
        { id: 10099, src: missing, name: 'gone', alt: 'gone' },
      ],
    }
    const p = project()

    const migrated = await runCli(['migrate'], { cwd: p.dir, env: p.env, timeoutMs: 120_000 })
    const imported = await runCli(
      ['import', '--source', 'woocommerce', '--url', woo.url, '--key', 'k', '--secret', 's'],
      { cwd: p.dir, env: p.env, timeoutMs: 120_000 },
    )

    expect(
      [migrated.code, imported.code],
      migrated.out.slice(-2000) + imported.out.slice(-3000),
    ).toEqual([0, 0])
    expect(imported.out).toContain('AI enrichment: off (the ai provider is none)')
    expect(imported.out).not.toMatch(/AI enriched:/)

    const served = woo.products.find((s) => s.id === 100)!
    const [row] = readRows<{ media: string }>(
      p.dbPath,
      `SELECT media FROM products WHERE slug = ?`,
      served.slug,
    )
    expect((JSON.parse(row!.media) as unknown[]).length).toBe(served.images.length)

    const report = readFileSync(join(p.dir, 'nymbal-migration-report.md'), 'utf8')
    const review = section(report, '## Review before launch')
    const mediaLines = review.items.filter((l) => l.includes(missing))
    expect(mediaLines.length, report).toBe(1)
    expect(mediaLines[0]).toContain('HTTP 404')
    expect(review.counts['Media'], report).toBe(1)

    const outro = /(\d+) errors, (\d+) to review before launch/.exec(imported.out)
    expect(outro, imported.out.slice(-2000)).not.toBeNull()
    // The outro's counts are the report's own: its error lines and its review lines.
    expect([Number(outro![1]), Number(outro![2])]).toEqual(
      ['## Errors Requiring Review', '## Review before launch'].map(
        (h) => section(report, h).items.length,
      ),
    )
  }, 180_000)
})
