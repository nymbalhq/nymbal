import { defineCommand } from 'citty'
import pc from 'picocolors'
import { loadConfig } from '@nymbal/config'
import { createApp, runSeed } from '@nymbal/platform'
import { createHttpServer } from '@nymbal/http'
import { run } from '../utils/spawn.js'
import { getCliVersion } from '../utils/version.js'

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
  },
  async run({ args }) {
    const { config, projectRoot } = await loadConfig()
    const version = getCliVersion()
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

    const templateFilter =
      config.template === 'astro' ? '@nymbal/template-astro' : '@nymbal/template-nextjs'

    // eslint-disable-next-line no-console
    console.log(
      pc.cyan(`→ Starting template: ${pc.bold(templateFilter)} (pnpm filter)`),
    )
    const apiUrl = `http://localhost:${config.http.port}`
    const templateProc = run('pnpm', ['--filter', templateFilter, 'dev'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NYMBAL_API_URL: apiUrl,
        // Client-side env vars for each framework (must be set before the dev server starts)
        PUBLIC_NYMBAL_API_URL: apiUrl,        // Astro
        NEXT_PUBLIC_NYMBAL_API_URL: apiUrl,   // Next.js
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
