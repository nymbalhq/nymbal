// The P2-02 AC-5 child process (primitive-graph tests): registers record.mjs, then runs createApp from the kernel's
// built dist on a migrated SQLite store, with the config in argv[2] (parsed by @nymbalhq/config). It prints one line,
// `P2-02-OUTCOME <json>`: what app.capabilities() reported for documentStore and eventBus, each instance's own
// capabilities(), and the report again after the document store instance's answer was replaced (so a report that is
// not read from the instance shows); or the error it threw.
import { mkdtempSync, rmSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

register(new URL('./record.mjs', import.meta.url), {
  data: JSON.parse(process.env.P2_02_GRAPH ?? '{}'),
})

const platformRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'p2-02-graph-'))
const sqlitePath = join(dir, 'store.sqlite')
const PROBE = ['p2-02-probe']
let outcome
try {
  const { nymbalConfigSchema } = await import('@nymbalhq/config')
  const config = nymbalConfigSchema.parse(JSON.parse(process.argv[2] ?? '{}'))
  // Inside the try: a kernel that imports an SDK statically fails here when the SDK is missing.
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
  try {
    const report = app.capabilities()
    const own = {
      documentStore: [...app.platform.documentStore.capabilities()],
      eventBus: [...app.platform.eventBus.capabilities()],
    }
    app.platform.documentStore.capabilities = () => PROBE
    outcome = {
      started: {
        report: { documentStore: report.documentStore, eventBus: report.eventBus },
        own,
        probed: app.capabilities().documentStore.capabilities,
      },
    }
  } finally {
    await app.stop()
  }
} catch (error) {
  outcome = {
    error: { name: error?.name, code: error?.code, message: String(error?.message ?? error) },
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.stdout.write(`P2-02-OUTCOME ${JSON.stringify(outcome)}\n`)
