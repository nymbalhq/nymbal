import { defineCommand } from 'citty'
import pc from 'picocolors'
import { loadConfig } from '@nymbal/config'
import { createApp, runSeed, createCommandStore, runMigrations } from '@nymbal/platform'
import { createHttpServer } from '@nymbal/http'
import { run } from '../utils/spawn.js'
import { getCliVersion } from '../utils/version.js'
import { findFreePort } from '../utils/port.js'
import { planTemplateLaunch } from '../utils/template-runner.js'
import { resolveMigrations } from './migrate.js'

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
    storefrontPort: {
      type: 'string',
      alias: 'storefront-port',
      description:
        'Port for the storefront dev server (default: 4321 Astro / 3000 Next.js). ' +
        'If busy, the next free port is used. Also settable via NYMBAL_STOREFRONT_PORT.',
    },
  },
  async run({ args }) {
    const { config, projectRoot } = await loadConfig()
    const version = getCliVersion()

    // Auto-migrate on startup so a fresh clone works without running `nymbal migrate` first
    const migrationsRoot = resolveMigrations(projectRoot)
    const migrateStore = createCommandStore(config)
    try {
      await runMigrations(migrateStore, { migrationsRoot })
    } finally {
      await migrateStore.close()
    }

    const app = await createApp(config, { version })
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
    await app.attachHttp(http.adapter)
    await http.start()

    if (args.apiOnly) {
      const shutdown = async (signal: string) => {
        platform.logger.info({ signal }, 'Shutting down API')
        await http.stop().catch(() => {})
        await app.stop().catch(() => {})
        process.exit(0)
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

    const apiUrl = `http://localhost:${config.http.port}`
    const storefrontUrl = `http://localhost:${storefrontPort}`
    // eslint-disable-next-line no-console
    console.log(
      pc.cyan(
        `→ Starting storefront (${pc.bold(config.template)}, ${launch.mode}) on ${pc.bold(storefrontUrl)}`,
      ),
    )
    // eslint-disable-next-line no-console
    console.log(pc.dim(`  API: ${apiUrl}`))

    const templateProc = run(launch.command, launch.args, {
      cwd: launch.cwd,
      env: {
        ...process.env,
        NYMBAL_API_URL: apiUrl,
        // Client-side env vars for each framework (must be set before the dev server starts)
        PUBLIC_NYMBAL_API_URL: apiUrl, // Astro
        NEXT_PUBLIC_NYMBAL_API_URL: apiUrl, // Next.js
        // The framework also reads the port flag; the env var keeps the scaffold
        // config (astro.config.mjs) in sync when it honours NYMBAL_STOREFRONT_PORT.
        NYMBAL_STOREFRONT_PORT: String(storefrontPort),
      },
    })

    const shutdown = async (signal: string) => {
      platform.logger.info({ signal }, 'Shutting down')
      try {
        templateProc.child.kill('SIGINT')
      } catch {
        // ignore
      }
      await http.stop().catch(() => {})
      await app.stop().catch(() => {})
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))

    const templateExit = await templateProc.done
    platform.logger.info({ code: templateExit }, 'Template process exited')
    await shutdown('template-exit')
  },
})
