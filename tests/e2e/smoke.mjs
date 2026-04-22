#!/usr/bin/env node
// End-to-end smoke test: boot the platform + HTTP server, seed, hit /health and /api/products.
// Bypasses jiti config loading — the file-based loader is exercised separately.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nymbalConfigSchema } from '@nymbal/config'
import { createPlatform, runSeed, runMigrations } from '@nymbal/platform'
import { createHttpServer } from '@nymbal/http'

const VERSION = '0.1.0-smoke'

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'nymbal-smoke-'))
  const config = nymbalConfigSchema.parse({
    store: { name: 'Smoke Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      cloud: 'local',
      commandStore: 'sqlite',
      documentStore: 'in-memory',
      eventBus: 'in-process',
      compute: 'in-process',
    },
    security: {
      adapter: 'middleware',
      rateLimit: {
        '/checkout': { requests: 10, window: '60s', action: 'block' },
      },
      csrf: false,
    },
    commerce: {
      payments: { provider: 'stripe', config: { secretKey: 'sk_test', webhookSecret: 'whsec' } },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'anthropic', config: { apiKey: 'sk-test' } },
    },
    http: { adapter: 'fastify', port: 13991, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  })

  const platform = createPlatform(config, { sqlitePath: join(tmp, 'smoke.db') })
  const migrationsRoot = new URL('../../packages/platform/migrations', import.meta.url).pathname
  await runMigrations(platform.commandStore, { migrationsRoot })

  await runSeed({
    config,
    commandStore: platform.commandStore,
    documentStore: platform.documentStore,
    eventBus: platform.eventBus,
    logger: platform.logger,
    version: VERSION,
  })

  const http = createHttpServer({
    config,
    logger: platform.logger,
    documentStore: platform.documentStore,
    version: VERSION,
  })
  await http.start()

  const base = `http://127.0.0.1:${config.http.port}`
  try {
    const healthRes = await fetch(`${base}/health`)
    const health = await healthRes.json()
    if (health.status !== 'ok') throw new Error(`/health returned ${JSON.stringify(health)}`)

    const productsRes = await fetch(`${base}/api/products?limit=50`)
    const products = await productsRes.json()
    if (!Array.isArray(products.items)) throw new Error('products.items not an array')
    if (products.items.length !== 24) {
      throw new Error(`expected 24 products, got ${products.items.length}`)
    }
    if (!productsRes.headers.get('content-security-policy')) {
      throw new Error('missing content-security-policy header')
    }
    if (productsRes.headers.get('x-content-type-options') !== 'nosniff') {
      throw new Error('missing x-content-type-options: nosniff')
    }

    console.log(`✓ smoke passed — ${products.items.length} products, security headers applied`)
  } finally {
    await http.stop()
    await platform.close()
  }
}

main().catch((err) => {
  console.error('✗ smoke failed:', err?.stack ?? err)
  process.exit(1)
})
