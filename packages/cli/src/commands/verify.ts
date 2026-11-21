import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { findConfigFile, nymbalConfigSchema } from '@nymbalhq/config'
import { createHttpServer } from '@nymbalhq/http'
import {
  createApp,
  createCommandStore,
  createLogger,
  runMigrations,
  runSeed,
} from '@nymbalhq/platform'
import { resolveAdminRoot } from '../admin.js'
import { loadProject } from '../utils/project.js'
import { runShutdown } from '../utils/shutdown.js'
import {
  freePortFrom,
  nextFilesOf,
  STOP_BOUND_MS,
  storefrontUp,
  throwawayStopSteps,
  type Throwaway,
} from '../utils/throwaway.js'
import { getCliVersion } from '../utils/version.js'
import { runJourney } from '../verify/journey.js'
import { defaultStorefrontPort, storefrontEnv } from './dev.js'
import { resolveMigrations } from './migrate.js'
import { previewConfig } from './preview-config.js'
import {
  buildPreviewStorefront,
  planPreviewStorefront,
  startPreviewStorefront,
} from './preview-lighthouse.js'

/** Verify's own Next.js dist dir, so it never shares a build with `nymbal preview` (`.next-preview`) or `.next`. */
const NEXT_DIST_DIR = '.next-verify'

const out = (line: string) => process.stdout.write(`verify: ${line}\n`)
const err = (line: string) => process.stderr.write(`verify: ${line}\n`)

/**
 * The project's pages, built for production, and a throwaway store of its own (SQLite, the built-in providers, the
 * demo catalogue), driven through the smoke journey. Nothing of the project's store, providers or database is used.
 */
async function runVerify(): Promise<void> {
  const running: Throwaway = {}
  let stopping = false
  const quiet = { info: () => undefined, error: (_: unknown, msg?: string) => err(msg ?? '') }
  const stop = (code: 0 | 1): Promise<never> => {
    stopping = true
    return runShutdown(throwawayStopSteps(running, { keepDir: false }), {
      boundMs: STOP_BOUND_MS,
      logger: quiet,
      exit: (c) => process.exit(code === 1 ? 1 : c),
    })
  }

  if (!findConfigFile(process.cwd())) {
    err(`no nymbal.config.ts in ${process.cwd()} or above: run nymbal verify in a store project`)
    process.exit(1)
  }

  try {
    const { config, projectRoot } = await loadProject()

    // After .env is loaded, so the merchant's admin pair is neither used nor printed.
    const admin = {
      email: `verify-${randomBytes(4).toString('hex')}@nymbal.local`,
      password: randomBytes(18).toString('base64url'),
    }
    process.env['NYMBAL_ADMIN_EMAIL'] = admin.email
    process.env['NYMBAL_ADMIN_PASSWORD'] = admin.password
    // The throwaway store runs the stub payments provider on purpose, which production refuses.
    delete process.env['NODE_ENV']

    const storefront = planPreviewStorefront(
      projectRoot,
      config.template,
      process.env,
      'nymbal verify',
    )
    if ('error' in storefront) throw new Error(storefront.error)

    const apiPort = await freePortFrom(config.http.port)
    const storefrontPort = await freePortFrom(defaultStorefrontPort(config.template), [apiPort])
    const apiUrl = `http://127.0.0.1:${apiPort}`
    const storefrontUrl = `http://127.0.0.1:${storefrontPort}`

    // A repeated signal waits for the stop under way (bounded by STOP_BOUND_MS): ending at once would skip the cleanup.
    const onSignal = () => {
      if (stopping) return
      err('stopped')
      void stop(1)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)

    const dir = await mkdtemp(join(tmpdir(), 'nymbal-verify-'))
    running.dir = dir
    const sqlitePath = join(dir, 'verify.db')
    // Parsed, so a swapped slot gets its block's defaults (the native tax engine reads its rate table).
    const store = nymbalConfigSchema.parse(
      previewConfig(config, {
        dir,
        apiPort,
        storefrontOrigin: `http://localhost:${storefrontPort}`,
        ai: false,
      }),
    )
    const commandStore = createCommandStore(store, { sqlitePath })
    try {
      await runMigrations(commandStore, { migrationsRoot: resolveMigrations(projectRoot) })
    } finally {
      await commandStore.close()
    }
    const version = getCliVersion()
    const logger = createLogger({
      base: { store: config.store.name },
      level: process.env['LOG_LEVEL'] || 'warn',
      destination: process.stderr,
    })
    const app = await createApp(store, {
      version,
      logger,
      sqlitePath,
      mediaRoot: join(dir, 'media'),
    })
    running.app = app
    await runSeed({
      config: store,
      commandStore: app.platform.commandStore,
      documentStore: app.platform.documentStore,
      eventBus: app.platform.eventBus,
      logger: app.platform.logger,
      version,
      search: app.adapters.search,
    })
    await app.relay.drain()

    const http = createHttpServer({
      config: store,
      logger,
      documentStore: app.platform.documentStore,
      version,
      network: app.network,
    })
    await app.attachHttp(http.adapter, { adminRoot: resolveAdminRoot() })
    running.http = http
    await http.start()

    if (stopping) return
    const env: NodeJS.ProcessEnv = {
      ...storefrontEnv(store, apiUrl, storefrontPort),
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(storefrontPort),
      NEXT_TELEMETRY_DISABLED: '1',
      ASTRO_TELEMETRY_DISABLED: '1',
    }
    if (storefront.template === 'nextjs' && storefront.bin !== null) {
      running.nextFiles = await nextFilesOf(storefront.cwd)
      running.nextDistDir = join(storefront.cwd, NEXT_DIST_DIR)
      env['NYMBAL_NEXT_DIST_DIR'] = NEXT_DIST_DIR
    }
    if (storefront.bin !== null) {
      out('building the storefront for production')
      try {
        await buildPreviewStorefront(storefront, {
          dir,
          env,
          onChild: (child) => (running.build = child),
          stopped: () => stopping,
        })
      } catch (error) {
        if (stopping) return
        err(`storefront build failed: ${error instanceof Error ? error.message : String(error)}`)
        await stop(1)
      }
    }
    if (stopping) return
    running.storefront = startPreviewStorefront(storefront, { dir, port: storefrontPort, env })
    await storefrontUp(storefrontUrl, running.storefront)

    if (stopping) return
    const results = await runJourney(
      { apiUrl, storefrontUrl, admin },
      {
        onStep: (result) => {
          if (stopping) return
          if (result.ok) out(`${result.step} ok`)
          else err(`${result.step} failed: ${result.detail}`)
        },
      },
    )
    if (stopping) return
    const passed = results.length > 0 && results.every((r) => r.ok)
    if (passed) out(`passed, ${results.length} steps`)
    await stop(passed ? 0 : 1)
  } catch (error) {
    if (stopping) return
    err(error instanceof Error ? error.message : String(error))
    await stop(1)
  }
}

export const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description:
      "Build the storefront for production and run a smoke journey (pages, cart, checkout, order, admin) on a throwaway store; your project's own store is not touched",
  },
  async run() {
    await runVerify()
  },
})
