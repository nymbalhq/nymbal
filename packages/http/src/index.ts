export {
  FastifyHttpAdapter,
  type CorsOptions,
  type FastifyAdapterOptions,
} from './fastify-adapter.js'
export {
  createSecurityGuard,
  buildSecurityHeaders,
  CSRF_COOKIE,
  CSRF_HEADER,
  type SecurityGuard,
} from './security-middleware.js'
export { RateLimiter } from './rate-limit.js'
export {
  createHttpServer,
  resolveTrustProxy,
  type HttpServer,
  type HttpServerDeps,
} from './server.js'
export { createHealthRoute } from './routes/health.js'
export { createReadyRoute, type ReadyState } from './routes/ready.js'
export {
  forwardToStorefront,
  type StorefrontForward,
  type StorefrontForwardOptions,
} from './storefront-forward.js'
export { createProductsRoute, type ProductListItem } from './routes/products.js'
export {
  mountMcp,
  mountToolEndpoint,
  MCP_PATH,
  type MountMcpDeps,
  type ToolEndpointDeps,
} from './mcp-route.js'
export {
  mountAgentSurfaces,
  UCP_MCP_PATH,
  HANDOFF_PATH,
  FEED_PATH,
  type MountAgentSurfacesDeps,
} from './agent-surface.js'
