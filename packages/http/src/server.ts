import type { NymbalConfig } from '@nymbalhq/config'
import {
  ConfigError,
  type DocumentStoreAdapter,
  type HttpAdapter,
  type HttpMethod,
  type Logger,
  type MiddlewareHandler,
  type RouteHandler,
  type RouteOptions,
} from '@nymbalhq/types'
import { FastifyHttpAdapter } from './fastify-adapter.js'
import { createHealthRoute } from './routes/health.js'
import { createProductsRoute } from './routes/products.js'

export interface HttpServerDeps {
  config: NymbalConfig
  logger: Logger
  documentStore: DocumentStoreAdapter
  version: string
}

export interface HttpServer {
  adapter: HttpAdapter
  registerRoute(
    method: HttpMethod,
    path: string,
    handler: RouteHandler,
    options?: RouteOptions,
  ): void
  registerMiddleware(middleware: MiddlewareHandler): void
  start(): Promise<{ port: number; host: string }>
  stop(): Promise<void>
}

const TRUST_PROXY_HOPS_ENV = 'NYMBAL_TRUST_PROXY_HOPS'

/**
 * `http.trustProxy`, with NYMBAL_TRUST_PROXY_HOPS filling it when the config leaves it `false`: the hop count is the
 * platform's, so it is set where the store runs, not in the config the image is built from. A set variable must be an
 * integer of 0 or more, whatever the config holds; Fastify would trust nothing, silently, below 0.
 */
export function resolveTrustProxy(config: NymbalConfig, env: NodeJS.ProcessEnv): boolean | number {
  const raw = env[TRUST_PROXY_HOPS_ENV]
  const hops = raw === undefined ? undefined : /^\d+$/.test(raw.trim()) ? Number(raw) : NaN
  if (hops !== undefined && !Number.isSafeInteger(hops)) {
    throw new ConfigError(`${TRUST_PROXY_HOPS_ENV} must be a whole number of proxy hops, 0 or more`, {
      code: 'config.trust_proxy_hops_invalid',
      context: { variable: TRUST_PROXY_HOPS_ENV },
    })
  }
  const configured = config.http.trustProxy
  return configured === false && hops !== undefined ? hops : configured
}

export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const { config, logger, documentStore, version } = deps
  if (config.http.adapter !== 'fastify') {
    throw new Error(`Unsupported http.adapter: ${config.http.adapter}`)
  }
  const adapter = new FastifyHttpAdapter({
    logger,
    cors: config.http.cors,
    security: config.security,
    trustProxy: resolveTrustProxy(config, process.env),
  })

  const server: HttpServer = {
    adapter,
    registerRoute(method, path, handler, options) {
      adapter.registerRoute(method, path, handler, options)
    },
    registerMiddleware(middleware) {
      adapter.registerMiddleware(middleware)
    },
    async start() {
      await adapter.start(config.http.port, config.http.host)
      return { port: adapter.boundPort, host: config.http.host }
    },
    async stop() {
      await adapter.stop()
    },
  }

  // Default routes — available without any user route registration.
  server.registerRoute('GET', '/health', createHealthRoute(version))
  // The commerce routes (including `/api/products`) are registered by
  // `platform.attachHttp(...)` — we intentionally do not pre-register them
  // here to avoid FST_ERR_DUPLICATED_ROUTE conflicts when the kernel is wired.
  void createProductsRoute
  void documentStore
  void config

  return server
}
