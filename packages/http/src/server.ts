import type { NymbalConfig } from '@nymbal/config'
import type {
  DocumentStoreAdapter,
  HttpAdapter,
  HttpMethod,
  Logger,
  MiddlewareHandler,
  RouteHandler,
  RouteOptions,
} from '@nymbal/types'
import { FastifyHttpAdapter } from './fastify-adapter.js'
import { createSecurityGuard, type SecurityGuard } from './security-middleware.js'
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
  security: SecurityGuard
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

export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const { config, logger, documentStore, version } = deps
  if (config.http.adapter !== 'fastify') {
    throw new Error(`Unsupported http.adapter: ${config.http.adapter}`)
  }
  const adapter = new FastifyHttpAdapter({ logger, cors: config.http.cors })
  const security = createSecurityGuard(config.security)

  const server: HttpServer = {
    adapter,
    security,
    registerRoute(method, path, handler, options) {
      adapter.registerRoute(method, path, security.wrap(handler), options)
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
