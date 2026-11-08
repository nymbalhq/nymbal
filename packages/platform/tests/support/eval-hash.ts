import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nymbalConfigSchema } from '@nymbalhq/config'
import { createApp } from '../../src/app.js'
import { assistantEvalHash } from '../../src/assistant/stamp.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'

// No Vitest import here, directly or through kernel.ts: release:check runs this under tsx.

const MIGRATIONS_ROOT = fileURLToPath(new URL('../../migrations', import.meta.url))

/**
 * The hash of the prompt and tools the assistant is sent from this checkout's `src/`, as a stamp records it. The tools
 * are the HTTP routes, so a throwaway store attaches them to an adapter that never listens.
 */
export async function currentAssistantEvalHash(): Promise<string> {
  const config = nymbalConfigSchema.parse({
    store: { name: 'Eval Hash', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', botProtection: { mode: 'off' } },
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
  })
  const dir = mkdtempSync(join(tmpdir(), 'eval-hash-'))
  const sqlitePath = join(dir, 'store.sqlite')
  try {
    const migrate = createCommandStore(config, { sqlitePath })
    try {
      await runMigrations(migrate, { migrationsRoot: MIGRATIONS_ROOT })
    } finally {
      await migrate.close()
    }
    const app = await createApp(config, {
      sqlitePath,
      logger: createLogger({ pretty: false, level: 'error' }),
    })
    try {
      const nothing = {
        registerRoute() {},
        registerStreamRoute() {},
        registerMiddleware() {},
        setDefaultHeaders() {},
        async start() {},
        async stop() {},
      }
      await app.attachHttp(nothing, { adminRoot: null })
      return assistantEvalHash(app.assistantTools!)
    } finally {
      await app.stop()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
