import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nymbalConfigSchema } from '@nymbalhq/config'
import { createHttpServer } from '@nymbalhq/http'
import {
  createApp,
  createCommandStore,
  createLogger,
  runMigrations,
  type NymbalApp,
} from '@nymbalhq/platform'
import type { MailSink } from './mail.js'

export interface TestStore {
  app: NymbalApp
  baseUrl: string
  stop(): Promise<void>
}

const HOST = '127.0.0.1'

// The monorepo layout: this file is packages/proof-kit/dist/*.js, the kernel's migrations packages/platform/migrations.
const MIGRATIONS_ROOT = new URL('../../platform/migrations', import.meta.url).pathname

// The config schema rejects port 0, so the port is found by binding one and releasing it.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

/**
 * A kernel on stub payments with migrations applied, served over HTTP on a free port. SQLite lives in its own temp
 * file unless `sqlitePath` is given; `email` points the native email adapter at a mail sink.
 */
export async function startTestStore(
  opts: {
    commandStore?: 'sqlite' | 'postgres'
    sqlitePath?: string
    postgresUrl?: string
    email?: MailSink
  } = {},
): Promise<TestStore> {
  const kind = opts.commandStore ?? 'sqlite'
  if (kind === 'postgres' && opts.postgresUrl === undefined) {
    throw new Error('startTestStore: commandStore "postgres" needs postgresUrl')
  }
  const dir =
    kind === 'sqlite' && opts.sqlitePath === undefined
      ? mkdtempSync(join(tmpdir(), 'proof-kit-store-'))
      : undefined
  const storage =
    kind === 'sqlite'
      ? { sqlitePath: opts.sqlitePath ?? join(dir!, 'store.sqlite') }
      : { postgresUrl: opts.postgresUrl! }
  const port = await freePort()

  const config = nymbalConfigSchema.parse({
    store: { name: 'Proof Kit', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      cloud: 'local',
      commandStore: kind,
      documentStore: 'in-memory',
      eventBus: 'in-process',
      compute: 'in-process',
    },
    security: { adapter: 'middleware', botProtection: { mode: 'off' } },
    commerce: {
      payments: { provider: 'native' },
      email: {
        provider: 'native',
        config: opts.email?.emailConfig() ?? { transport: 'console' },
      },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port, host: HOST },
    deployment: { strategy: 'standard' },
  })
  const logger = createLogger({ pretty: false, level: 'error' })

  // createApp warms the document store from the tables, so they exist before it runs.
  const migrateStore = createCommandStore(config, storage)
  try {
    await runMigrations(migrateStore, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await migrateStore.close()
  }

  const app = await createApp(config, { ...storage, logger })
  const http = createHttpServer({
    config,
    logger,
    documentStore: app.platform.documentStore,
    version: '0.0.0',
  })
  await app.attachHttp(http.adapter)
  await http.start()

  return {
    app,
    baseUrl: `http://${HOST}:${port}`,
    async stop() {
      await http.stop()
      await app.stop()
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    },
  }
}
