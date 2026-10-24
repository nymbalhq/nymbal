// The child process of adapter-graph.test.ts: registers record-resolve.mjs, then runs createApp from the kernel's built
// dist on a migrated SQLite store, with the config in argv[2] (parsed by @nymbalhq/config).
// It prints one line, `ADAPTER-GRAPH-OUTCOME <json>`: the payments and ai providerName it started with, or the error it threw.
import { mkdtempSync, rmSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

register(new URL('./record-resolve.mjs', import.meta.url), {
  data: JSON.parse(process.env.ADAPTERS_GRAPH ?? '{}'),
})

const platformRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const { nymbalConfigSchema } = await import('@nymbalhq/config')

const config = nymbalConfigSchema.parse(JSON.parse(process.argv[2] ?? '{}'))
const dir = mkdtempSync(join(tmpdir(), 'adapters-graph-'))
const sqlitePath = join(dir, 'store.sqlite')
let outcome
try {
  // Inside the try: a kernel that imports an SDK statically fails here when the SDK is missing or broken.
  const kernel = await import(pathToFileURL(join(platformRoot, 'dist', 'index.js')).href)
  const store = kernel.createCommandStore(config, { sqlitePath })
  try {
    await kernel.runMigrations(store, { migrationsRoot: join(platformRoot, 'migrations') })
  } finally {
    await store.close()
  }
  const app = await kernel.createApp(config, {
    sqlitePath,
    logger: kernel.createLogger({ pretty: false, level: 'silent' }),
  })
  outcome = {
    started: {
      payments: app.adapters.payments.providerName,
      ai: app.adapters.ai === null ? null : app.adapters.ai.providerName,
    },
  }
  await app.stop()
} catch (error) {
  outcome = {
    error: { name: error?.name, code: error?.code, message: String(error?.message ?? error) },
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.stdout.write(`ADAPTER-GRAPH-OUTCOME ${JSON.stringify(outcome)}\n`)
