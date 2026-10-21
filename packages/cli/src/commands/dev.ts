import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import pc from 'picocolors'
import { KNOWN_PROVIDERS, type NymbalConfig } from '@nymbalhq/config'
import type { CommerceSlot } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'
import { createApp, createLogger, runSeed, sqliteFile, type NymbalApp } from '@nymbalhq/platform'
import { createHttpServer } from '@nymbalhq/http'
import { run } from '../utils/spawn.js'
import { getCliVersion } from '../utils/version.js'
import { findFreePort } from '../utils/port.js'
import { planTemplateLaunch } from '../utils/template-runner.js'
import { migrateProject } from './migrate.js'
import { resolveAdminRoot } from '../admin.js'
import { runShutdown, SHUTDOWN_BOUND_MS, type ShutdownStep } from '../utils/shutdown.js'
import { renderDevSummary, type DevSummaryInfo } from './dev-summary.js'

/** Default storefront dev-server port per template (matches the scaffold scripts). */
export function defaultStorefrontPort(template: 'astro' | 'nextjs'): number {
  return template === 'astro' ? 4321 : 3000
}

/**
 * Resolve the *preferred* storefront port from (in priority order):
 *   1. --storefront-port flag
 *   2. NYMBAL_STOREFRONT_PORT env var
 *   3. the template default (Astro 4321 / Next.js 3000)
 * The value returned here is only the starting point; the dev command then
 * probes upward for a genuinely free port so a busy default never hard-fails.
 */
export function preferredStorefrontPort(
  template: 'astro' | 'nextjs',
  flagPort: number | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (typeof flagPort === 'number' && Number.isFinite(flagPort)) return flagPort
  const fromEnv = env['NYMBAL_STOREFRONT_PORT']
  if (fromEnv && fromEnv.trim() !== '') {
    const parsed = Number(fromEnv)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return defaultStorefrontPort(template)
}

/**
 * The environment the storefront dev server starts with. The client-side variables must be set before it starts. It
 * says nothing about the adapters: a storefront learns what the store can do from GET /api/capabilities.
 */
export function storefrontEnv(
  _config: NymbalConfig,
  apiUrl: string,
  storefrontPort: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    NYMBAL_API_URL: apiUrl,
    PUBLIC_NYMBAL_API_URL: apiUrl, // Astro
    NEXT_PUBLIC_NYMBAL_API_URL: apiUrl, // Next.js
    // The framework also reads the port flag; the env var keeps the scaffold
    // config (astro.config.mjs) in sync when it honours NYMBAL_STOREFRONT_PORT.
    NYMBAL_STOREFRONT_PORT: String(storefrontPort),
  }
}

/** dev logs at info, so it prints the summary and not every projection; `LOG_LEVEL` wins over `--verbose`. */
export function devLogLevel(verbose: boolean, env: NodeJS.ProcessEnv): string {
  const fromEnv = env['LOG_LEVEL']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return verbose ? 'debug' : 'info'
}

/** The summary's facts, from the running app: no URL here carries anything but what the config gave. */
function summaryInfo(
  config: NymbalConfig,
  app: NymbalApp,
  apiUrl: string,
  storefront: DevSummaryInfo['storefront'],
  adminBuilt: boolean,
): DevSummaryInfo {
  const report = app.capabilities()
  return {
    store: config.store.name,
    apiUrl,
    storefront,
    admin: adminBuilt ? { url: `${apiUrl}/admin/` } : null,
    commandStore:
      config.infrastructure.commandStore === 'sqlite'
        ? { kind: 'sqlite', path: resolve(sqliteFile()) }
        : { kind: 'postgres', url: process.env['DATABASE_URL'] ?? '' },
    slots: (Object.keys(KNOWN_PROVIDERS) as CommerceSlot[]).map((slot) => ({
      slot,
      provider: report[slot].provider,
      capabilities: report[slot].capabilities,
    })),
    primitives: (['documentStore', 'eventBus', 'media'] as const).map((name) => ({
      name,
      provider: report[name].provider,
    })),
  }
}

/** The API port: `--port` when given, else the config's `http.port`. */
function apiPort(config: NymbalConfig, flagPort: string | undefined): number {
  if (flagPort === undefined || flagPort.trim() === '') return config.http.port
  const port = Number(flagPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be an integer from 1 to 65535, got "${flagPort}"`)
  }
  return port
}

export const devCommand = defineCommand({
  meta: {
    name: 'dev',
    description: 'Start the API server and the configured storefront template with HMR',
  },
  args: {
    seed: {
      type: 'boolean',
      description: 'Run seed before starting (default: true if empty)',
      default: true,
    },
    apiOnly: {
      type: 'boolean',
      // `alias` is required: citty 0.1.6 registers the camelCase key `apiOnly`
      // with mri and applies `default: false`. Without this alias a kebab
      // `--api-only` flag lands on `args['api-only']`, but `args.apiOnly`
      // resolves to the `false` default first (`??` does not fall through on
      // `false`), so the flag is silently ignored. The alias makes mri map
      // `--api-only` straight to `apiOnly`. Both forms now work.
      alias: 'api-only',
      description: 'Start only the API server (skip template dev server)',
      default: false,
    },
    port: {
      type: 'string',
      description: "Port for the API server (default: the config's http.port)",
    },
    storefrontPort: {
      type: 'string',
      alias: 'storefront-port',
      description:
        'Port for the storefront dev server (default: 4321 Astro / 3000 Next.js). ' +
        'If busy, the next free port is used. Also settable via NYMBAL_STOREFRONT_PORT.',
    },
    verbose: {
      type: 'boolean',
      description: 'Log at debug (LOG_LEVEL, when set, wins)',
      default: false,
    },
  },
  async run({ args }) {
    const loaded = await loadProject()
    const { projectRoot } = loaded
    const port = apiPort(loaded.config, args.port)
    const config: NymbalConfig = { ...loaded.config, http: { ...loaded.config.http, port } }
    const version = getCliVersion()

    // Auto-migrate on startup so a fresh clone works without running `nymbal migrate` first
    await migrateProject(config, projectRoot)

    const logger = createLogger({
      base: { store: config.store.name },
      level: devLogLevel(args.verbose, process.env),
    })
    const app = await createApp(config, {
      version,
      logger,
      ...(loaded.adapters !== undefined && { adapters: loaded.adapters }),
    })
    const { platform } = app

    if (args.seed) {
      const existing = await platform.documentStore.query('products', {
        partitionKey: { field: 'storeId', value: config.store.name },
        limit: 1,
      })
      if (existing.items.length === 0) {
        platform.logger.info({}, 'Seeding demo content (first run)')
        await runSeed({
          config,
          commandStore: platform.commandStore,
          documentStore: platform.documentStore,
          eventBus: platform.eventBus,
          logger: platform.logger,
          version,
        })
      }
    }

    const http = createHttpServer({
      config,
      logger: platform.logger,
      documentStore: platform.documentStore,
      version,
    })
    const adminRoot = resolveAdminRoot()
    await app.attachHttp(http.adapter, { adminRoot })
    await http.start()
    const apiUrl = `http://localhost:${config.http.port}`
    const printSummary = (storefront: DevSummaryInfo['storefront']) => {
      // eslint-disable-next-line no-console
      console.log(renderDevSummary(summaryInfo(config, app, apiUrl, storefront, adminRoot !== null)))
    }

    const stopApi: ShutdownStep[] = [
      { name: 'http.stop', run: () => http.stop() },
      { name: 'app.stop', run: () => app.stop() },
    ]
    const shutdownWith = (steps: ShutdownStep[]): Promise<never> =>
      runShutdown(steps, {
        boundMs: SHUTDOWN_BOUND_MS,
        logger: platform.logger,
        exit: (code) => process.exit(code),
      })

    if (args.apiOnly) {
      printSummary(null)
      const shutdown = (signal: string) => {
        platform.logger.info({ signal }, 'Shutting down API')
        return shutdownWith(stopApi)
      }
      process.on('SIGINT', () => void shutdown('SIGINT'))
      process.on('SIGTERM', () => void shutdown('SIGTERM'))
      // Keep process alive — Playwright webServer will kill it when done
      return
    }

    // Resolve a free storefront port. The preferred port is configurable but may
    // be taken (a developer commonly has another project on 4321/3000), so we
    // probe upward for a free one instead of hard-failing.
    const flagPortRaw = args.storefrontPort
    const flagPort =
      typeof flagPortRaw === 'string' && flagPortRaw.trim() !== '' ? Number(flagPortRaw) : undefined
    const preferred = preferredStorefrontPort(config.template, flagPort, process.env)
    const storefrontPort = await findFreePort(preferred)
    if (storefrontPort !== preferred) {
      // eslint-disable-next-line no-console
      console.log(
        pc.yellow(
          `→ Storefront port ${preferred} is busy; using free port ${pc.bold(String(storefrontPort))} instead.`,
        ),
      )
    }

    // Plan how to launch the storefront. A flat scaffold (create-nymbal-app
    // output) runs the framework dev server directly in the project root; a
    // monorepo layout falls back to a pnpm --filter on the template package.
    const launch = planTemplateLaunch(projectRoot, config.template, storefrontPort)

    const storefrontUrl = `http://localhost:${storefrontPort}`
    const templateProc = run(launch.command, launch.args, {
      cwd: launch.cwd,
      env: storefrontEnv(config, apiUrl, storefrontPort),
    })
    printSummary({ template: `${config.template}, ${launch.mode}`, url: storefrontUrl })

    let shuttingDown = false
    const shutdown = (signal: string) => {
      shuttingDown = true
      platform.logger.info({ signal }, 'Shutting down')
      return shutdownWith([
        {
          name: 'storefront.kill',
          run: async () => {
            templateProc.child.kill('SIGINT')
          },
        },
        ...stopApi,
      ])
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))

    const templateExit = await templateProc.done
    platform.logger.info({ code: templateExit }, 'Template process exited')
    // A Ctrl-C reaches the storefront too, so it exits during the signal's own shutdown, which ends the process.
    // Calling `runShutdown` again would count as a repeat signal and exit 1 at once.
    if (shuttingDown) return
    await shutdown('template-exit')
  },
})
