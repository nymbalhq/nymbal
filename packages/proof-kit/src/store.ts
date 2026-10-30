import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { createHttpServer, type HttpServer } from '@nymbalhq/http'
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
const MIGRATIONS_ROOT = fileURLToPath(new URL('../../platform/migrations', import.meta.url))

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

function addressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

/**
 * Serves the app on `port`. Another worker can take the port between the probe and the bind, so a lost race is retried
 * once on a fresh port and fresh server; a second loss in a row is not a race worth hiding.
 */
async function serve(
  app: NymbalApp,
  config: NymbalConfig,
  logger: ReturnType<typeof createLogger>,
  port: number,
): Promise<{ http: HttpServer; port: number }> {
  for (let attempt = 0; ; attempt += 1) {
    const http = createHttpServer({
      config: { ...config, http: { ...config.http, port } },
      logger,
      documentStore: app.platform.documentStore,
      version: '0.0.0',
    })
    await app.attachHttp(http.adapter)
    try {
      await http.start()
      return { http, port }
    } catch (error) {
      if (attempt > 0 || !addressInUse(error)) throw error
      port = await freePort()
    }
  }
}

/** Runs every step even when one throws; the first failure is thrown, or all of them when several fail. */
async function runAll(steps: Array<() => unknown>, message: string): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

/**
 * A kernel on stub payments with migrations applied, served over HTTP on a free port. SQLite lives in its own temp
 * file unless `sqlitePath` is given; `email` sends the store's mail to a mail sink through the `smtp` provider.
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
  const removeDir = (): void => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
  let app: NymbalApp | undefined
  let served: { http: HttpServer; port: number } | undefined
  try {
    const config = configure(kind, opts.email, await freePort())
    const logger = createLogger({ pretty: false, level: 'error' })

    // createApp warms the document store from the tables, so they exist before it runs.
    const migrateStore = createCommandStore(config, storage)
    try {
      await runMigrations(migrateStore, { migrationsRoot: MIGRATIONS_ROOT })
    } finally {
      await migrateStore.close()
    }

    app = await createApp(config, { ...storage, logger })
    served = await serve(app, config, logger, config.http.port)
  } catch (error) {
    try {
      await runAll(
        [() => served?.http.stop(), () => app?.stop(), removeDir],
        'startTestStore: several cleanup steps failed',
      )
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'startTestStore failed, and so did its cleanup',
      )
    }
    throw error
  }

  const { http, port } = served
  const running = app
  return {
    app: running,
    baseUrl: `http://${HOST}:${port}`,
    stop: () =>
      runAll(
        [() => http.stop(), () => running.stop(), removeDir],
        'TestStore.stop: several steps failed',
      ),
  }
}

function configure(
  kind: 'sqlite' | 'postgres',
  email: MailSink | undefined,
  port: number,
): NymbalConfig {
  return nymbalConfigSchema.parse({
    store: { name: 'Proof Kit', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: kind,
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', botProtection: { mode: 'off' } },
    commerce: {
      payments: { provider: 'native' },
      email: email
        ? { provider: 'smtp', config: email.emailConfig() }
        : { provider: 'native', config: { transport: 'console' } },
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
}
