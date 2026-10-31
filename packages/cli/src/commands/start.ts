import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { defineCommand } from 'citty'
import pc from 'picocolors'
import type { NymbalConfig } from '@nymbalhq/config'
import { boundedHealthCheck, ConfigError, type HealthReport } from '@nymbalhq/types'
import {
  createApp,
  createCommandStore,
  createLogger,
  keyProblem,
  migrationState,
  readSecretsKey,
  resolveAuthSecret,
  runMigrations,
  type CommandStore,
} from '@nymbalhq/platform'
import {
  createHttpServer,
  createReadyRoute,
  FastifyHttpAdapter,
  forwardToStorefront,
  resolveTrustProxy,
  type ReadyState,
} from '@nymbalhq/http'
import { loadProject } from '../utils/project.js'
import { getCliVersion } from '../utils/version.js'
import { runShutdown, type ShutdownStep } from '../utils/shutdown.js'
import { resolveAdminRoot } from '../admin.js'
import { resolveMigrations } from './migrate.js'

const DEFAULT_PORT = 3001
const DEFAULT_SHUTDOWN_MS = 10_000
const STOREFRONT_START_MS = 60_000

/** The public origin `value` names: http(s), no path, query or credentials; else null. */
function publicOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    const plain =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    return plain ? url.origin : null
  } catch {
    return null
  }
}

/**
 * Every reason the environment cannot run `config` in production, one line each, naming the variable and never its
 * value. Empty when `nymbal start` may go on.
 */
export function checkStartEnv(config: NymbalConfig, env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = []
  const isSet = (name: string): boolean => (env[name] ?? '').trim() !== ''
  const infra = config.infrastructure
  if (infra.commandStore === 'postgres' && !isSet('DATABASE_URL')) {
    problems.push('DATABASE_URL is not set: the postgres command store connects with it')
  }
  const onRedis =
    infra.documentStore.provider === 'redis' || infra.eventBus.provider === 'redis-streams'
  if (onRedis && infra.redis?.url === undefined && !isSet('REDIS_URL')) {
    problems.push(
      'REDIS_URL is not set: the Redis document store and event bus connect with it (or set infrastructure.redis.url)',
    )
  }
  const key = readSecretsKey(env)
  if (!key.ok) {
    problems.push(`${keyProblem(key.reason)}: settings are encrypted with it`)
  }
  if (!isSet('NYMBAL_PUBLIC_URL')) {
    problems.push("NYMBAL_PUBLIC_URL is not set: give the store's public origin, such as https://…")
  } else if (publicOrigin(env['NYMBAL_PUBLIC_URL']) === null) {
    problems.push('NYMBAL_PUBLIC_URL must be an http or https origin with no path')
  }
  // The app refuses a malformed NYMBAL_JWT_SECRET or NYMBAL_TRUST_PROXY_HOPS under any NODE_ENV, by the same check.
  const refusal = <T>(check: () => T): T | undefined => {
    try {
      return check()
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      problems.push(error.message)
      return undefined
    }
  }
  const jwt = refusal(() => resolveAuthSecret(config, env))
  refusal(() => resolveTrustProxy(config, env))
  if (env['NODE_ENV'] === 'development') {
    problems.push('NODE_ENV is development: nymbal start runs in production; unset it')
  }
  // The refusals the app makes while it is built in production, read from the config here so they come with the rest.
  if (env['NODE_ENV'] === 'production') {
    if (config.commerce.payments.provider === 'native') {
      problems.push(
        'commerce.payments.provider is native, the stub that verifies no webhook signature ' +
          '(config.production_stub_payments): configure a real payments provider, such as `nymbal add stripe`',
      )
    }
    if (jwt?.source === 'default') {
      problems.push(
        'security.auth.jwtSecret is the schema default (config.production_default_jwt_secret): ' +
          'set NYMBAL_JWT_SECRET (create-nymbal-app writes one into .env) or a secret of your own in nymbal.config.ts',
      )
    }
  }
  return problems
}

/** The NYMBAL_* variables the storefront reads; every other one is the store's own (the key, the admin password). */
const STOREFRONT_NYMBAL_ENV = new Set([
  'NYMBAL_API_URL',
  'NYMBAL_PUBLIC_URL',
  'NYMBAL_CATALOG_REVALIDATE_S',
  'NYMBAL_NEXT_DIST_DIR',
])

/**
 * The environment without the store's own secrets: the storefront never needs the database, Redis or the platform's
 * keys, but a store developer's own server-side variables (a CMS or analytics key) must still reach it.
 */
function storefrontEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        name !== 'DATABASE_URL' &&
        name !== 'REDIS_URL' &&
        (!name.startsWith('NYMBAL_') || STOREFRONT_NYMBAL_ENV.has(name)),
    ),
  )
}

function fail(lines: string[]): never {
  for (const line of lines) process.stderr.write(`${pc.red(line)}\n`)
  process.exit(1)
}

/** The public port: `--port`, else PORT, else 3001. */
function publicPort(flag: string | undefined, env: NodeJS.ProcessEnv): number {
  const given = flag !== undefined && flag.trim() !== '' ? flag : env['PORT']
  if (given === undefined || given.trim() === '') return DEFAULT_PORT
  const port = Number(given)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail([`The port must be an integer from 1 to 65535, got "${given}"`])
  }
  return port
}

function shutdownBound(env: NodeJS.ProcessEnv): number {
  const ms = Number(env['NYMBAL_SHUTDOWN_MS'])
  return Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_SHUTDOWN_MS
}

/**
 * How the built storefront starts on an internal port, or the line saying it is not built. NYMBAL_STOREFRONT_ENTRY
 * runs `node <file>` in its place.
 */
function storefrontLaunch(
  root: string,
  template: 'astro' | 'nextjs',
  env: NodeJS.ProcessEnv,
): ((port: number) => string[]) | string {
  const entry = env['NYMBAL_STOREFRONT_ENTRY']
  if (entry !== undefined && entry.trim() !== '') {
    const file = resolve(root, entry)
    return () => [file]
  }
  if (template === 'astro') {
    const file = join(root, 'dist', 'server', 'entry.mjs')
    if (!existsSync(file)) return 'The storefront is not built: run `nymbal build` first'
    return () => [file]
  }
  if (!existsSync(join(root, '.next', 'BUILD_ID'))) {
    return 'The storefront is not built: run `nymbal build` first'
  }
  const next = createRequire(join(root, 'package.json')).resolve('next/dist/bin/next')
  return (port) => [next, 'start', '-H', '127.0.0.1', '-p', String(port)]
}

/** Refuses to go on over pending migrations unless asked to apply them. */
async function migrationGate(
  config: NymbalConfig,
  migrationsRoot: string,
  apply: boolean,
): Promise<void> {
  const store = createCommandStore(config)
  try {
    const { pending } = await migrationState(store, { migrationsRoot })
    if (pending === 0) return
    if (!apply) {
      fail([
        `${pending} migration${pending === 1 ? '' : 's'} pending: run \`nymbal migrate\` (a deploy's release step does), ` +
          'or `nymbal start --migrate` on a single host',
      ])
    }
    await runMigrations(store, { migrationsRoot })
  } finally {
    await store.close()
  }
}

/** A free port on the loopback interface, for the storefront. */
function loopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolvePort(port))
    })
  })
}

/** Resolves true once `port` on the loopback accepts a connection; false when `gone` settles or `withinMs` passes. */
async function listening(port: number, gone: Promise<void>, withinMs: number): Promise<boolean> {
  let exited = false
  void gone.then(() => (exited = true))
  const deadline = Date.now() + withinMs
  while (!exited && Date.now() < deadline) {
    const open = await new Promise<boolean>((resolveOpen) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolveOpen(true)
      })
      socket.once('error', () => resolveOpen(false))
    })
    if (open) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/** Down unless the store's schema is the one this build expects. */
async function commandStoreReport(
  store: CommandStore,
  migrationsRoot: string,
): Promise<HealthReport> {
  const { pending } = await migrationState(store, { migrationsRoot })
  return { status: pending === 0 ? 'healthy' : 'down' }
}

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description:
      'Run the built store in production: the API, the admin and the storefront on one port',
  },
  args: {
    migrate: {
      type: 'boolean',
      description: 'Apply pending migrations first (a single host; a deploy runs `nymbal migrate`)',
      default: false,
    },
    port: {
      type: 'string',
      description: 'The public port (default: PORT, else 3001)',
    },
  },
  async run({ args }) {
    // Until the shutdown sequence takes over, a stop ends the boot at once: as PID 1 in a container an unhandled
    // SIGTERM is ignored, and the storefront, once spawned, must not outlive this process.
    let child: ChildProcess | null = null
    const childAlive = (): boolean =>
      child !== null && child.exitCode === null && child.signalCode === null
    const stopBoot = (): void => {
      if (childAlive()) child!.kill('SIGKILL')
      process.exit(1)
    }
    process.on('SIGTERM', stopBoot)
    process.on('SIGINT', stopBoot)

    const loaded = await loadProject().catch((error: unknown) =>
      fail([error instanceof Error ? error.message : String(error)]),
    )
    const { projectRoot } = loaded
    if ((process.env['NODE_ENV'] ?? '') === '') process.env['NODE_ENV'] = 'production'
    const problems = checkStartEnv(loaded.config, process.env)
    if (problems.length > 0) fail(problems)

    const port = publicPort(args.port, process.env)
    const publicUrl = publicOrigin(process.env['NYMBAL_PUBLIC_URL'])!
    const launch = storefrontLaunch(projectRoot, loaded.config.template, process.env)
    if (typeof launch === 'string') fail([launch])
    const config: NymbalConfig = {
      ...loaded.config,
      http: {
        ...loaded.config.http,
        port,
        // The store's own pages subscribe to alerts and call the API from this origin.
        cors: {
          ...loaded.config.http.cors,
          allowedOrigins: [...new Set([...loaded.config.http.cors.allowedOrigins, publicUrl])],
        },
      },
    }
    const migrationsRoot = resolveMigrations(projectRoot)
    await migrationGate(config, migrationsRoot, args.migrate)

    const version = getCliVersion()
    const logger = createLogger({
      base: { store: config.store.name },
      level: process.env['LOG_LEVEL'] || 'info',
    })
    const app = await createApp(config, {
      version,
      logger,
      ...(loaded.adapters !== undefined && { adapters: loaded.adapters }),
    }).catch((error: unknown) => {
      if (!(error instanceof ConfigError)) throw error
      return fail([error.message])
    })
    const { platform } = app

    let stopping = false
    const downAs = async (
      name: string,
      check: () => Promise<HealthReport> | HealthReport,
    ): Promise<string | null> => ((await boundedHealthCheck(check)).status === 'down' ? name : null)
    const probe = async (): Promise<ReadyState> => {
      if (stopping) return { ready: false, failing: [] }
      const down = (
        await Promise.all([
          downAs('command-store', () => commandStoreReport(platform.commandStore, migrationsRoot)),
          downAs(
            'document-store',
            () => platform.documentStore.healthCheck?.() ?? { status: 'degraded' },
          ),
          downAs('event-bus', () => platform.eventBus.healthCheck?.() ?? { status: 'degraded' }),
        ])
      ).filter((name): name is string => name !== null)
      return down.length === 0 ? { ready: true } : { ready: false, failing: down }
    }

    const http = createHttpServer({
      config,
      logger: platform.logger,
      documentStore: platform.documentStore,
      version,
    })
    http.registerRoute('GET', '/ready', createReadyRoute(probe))
    await app.attachHttp(http.adapter, { adminRoot: resolveAdminRoot() })
    if (!(http.adapter instanceof FastifyHttpAdapter)) {
      throw new Error('nymbal start needs the fastify http adapter')
    }
    const internalPort = await loopbackPort()
    const forward = forwardToStorefront(http.adapter, { port: internalPort, publicUrl })

    const storefront = spawn(process.execPath, launch(internalPort), {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...storefrontEnv(process.env),
        HOST: '127.0.0.1',
        PORT: String(internalPort),
        NYMBAL_API_URL: `http://127.0.0.1:${port}`,
        NYMBAL_PUBLIC_URL: publicUrl,
      },
    })
    child = storefront
    const childGone = new Promise<void>((resolveGone) => {
      storefront.once('exit', () => resolveGone())
      storefront.once('error', () => resolveGone())
    })
    // However the process ends, the storefront ends with it.
    process.on('exit', () => {
      if (childAlive()) storefront.kill('SIGKILL')
    })
    // The public port opens once the storefront can answer, so no page meets a 503 while it starts.
    if (!(await listening(internalPort, childGone, STOREFRONT_START_MS))) {
      fail([`The storefront did not start listening within ${STOREFRONT_START_MS / 1000} s`])
    }
    const bound = await http.start()
    // eslint-disable-next-line no-console
    console.log(`nymbal start: ${publicUrl} on port ${bound.port}`)

    const boundMs = shutdownBound(process.env)
    // What the drain leaves of the bound: enough to stop the storefront, then the API and the app.
    const reserveMs = Math.min(3000, Math.floor(boundMs * 0.3))
    const steps: ShutdownStep[] = [
      {
        name: 'ready.refuse',
        run: async () => {
          stopping = true
        },
      },
      {
        name: 'storefront.drain',
        run: async () => {
          forward.refuse()
          if (!(await forward.drained(boundMs - reserveMs))) {
            platform.logger.warn({ inFlight: forward.inFlight() }, 'Page requests still open')
          }
        },
      },
      {
        name: 'storefront.stop',
        run: async () => {
          if (!childAlive()) return
          storefront.kill('SIGTERM')
          let timer: ReturnType<typeof setTimeout> | undefined
          const graceful = await Promise.race([
            childGone.then(() => true),
            new Promise<boolean>((r) => (timer = setTimeout(() => r(false), reserveMs / 2))),
          ])
          clearTimeout(timer)
          if (!graceful) {
            storefront.kill('SIGKILL')
            await childGone
          }
        },
      },
      { name: 'http.stop', run: () => http.stop() },
      { name: 'app.stop', run: () => app.stop() },
    ]
    let failed = false
    const shutdown = (reason: string): Promise<never> => {
      platform.logger.info({ reason }, 'Shutting down')
      return runShutdown(steps, {
        boundMs,
        logger: platform.logger,
        exit: (code) => process.exit(failed ? 1 : code),
      })
    }
    process.off('SIGTERM', stopBoot)
    process.off('SIGINT', stopBoot)
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    process.on('SIGINT', () => void shutdown('SIGINT'))
    void childGone.then(() => {
      if (stopping) return
      // A store with no storefront takes no page traffic: exit so the platform restarts it.
      failed = true
      platform.logger.error(
        { code: storefront.exitCode, signal: storefront.signalCode },
        'The storefront exited',
      )
      void shutdown('storefront-exit')
    })
  },
})
