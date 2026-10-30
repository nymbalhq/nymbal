// The child process of adapter-resolution.test.ts, run with the module hooks of tests/support/module-hooks.ts in
// NODE_OPTIONS. It parses the raw config in argv[2] with @nymbalhq/config, migrates a SQLite store, writes the settings
// rows in ADAPTER_RESOLUTION's `settings` ([{ slot, path, value }], plain values), runs createApp from the kernel's
// built dist and prints one line, `ADAPTER-RESOLUTION-OUTCOME <json>`: the payments and security adapters it started
// with, or the error it threw, and what the fixture adapters were built with.
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const platformRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const options = JSON.parse(process.env.ADAPTER_RESOLUTION ?? '{}')
const dir = mkdtempSync(join(tmpdir(), 'adapter-resolution-'))
const sqlitePath = join(dir, 'store.sqlite')
let outcome
try {
  const { nymbalConfigSchema } = await import('@nymbalhq/config')
  const config = nymbalConfigSchema.parse(JSON.parse(process.argv[2] ?? '{}'))
  const kernel = await import(pathToFileURL(join(platformRoot, 'dist', 'index.js')).href)
  const store = kernel.createCommandStore(config, { sqlitePath })
  try {
    await kernel.runMigrations(store, { migrationsRoot: join(platformRoot, 'migrations') })
  } finally {
    await store.close()
  }
  const rows = options.settings ?? []
  if (rows.length > 0) {
    const Database = createRequire(join(platformRoot, 'package.json'))('better-sqlite3')
    const db = new Database(sqlitePath)
    const insert = db.prepare(
      'INSERT INTO settings (slot, path, plain, updated_at) VALUES (?, ?, ?, ?)',
    )
    for (const row of rows) insert.run(row.slot, row.path, row.value, new Date().toISOString())
    db.close()
  }
  const app = await kernel.createApp(config, {
    sqlitePath,
    logger: kernel.createLogger({ pretty: false, level: 'silent' }),
  })
  outcome = {
    started: {
      payments: app.adapters.payments.providerName,
      security: {
        providerName: app.adapters.security.providerName ?? null,
        capabilities: [...app.adapters.security.capabilities()],
      },
    },
  }
  await app.stop()
} catch (error) {
  outcome = {
    error: {
      name: error?.name,
      code: error?.code,
      message: String(error?.message ?? error),
      context: error?.context ?? null,
    },
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
outcome.received = globalThis.__nymbalFixtureReceived ?? {}
process.stdout.write(`ADAPTER-RESOLUTION-OUTCOME ${JSON.stringify(outcome)}\n`)
