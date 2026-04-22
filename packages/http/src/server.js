import { FastifyHttpAdapter } from './fastify-adapter.js';
import { createSecurityGuard } from './security-middleware.js';
import { createHealthRoute } from './routes/health.js';
import { createProductsRoute } from './routes/products.js';
export function createHttpServer(deps) {
    const { config, logger, documentStore, version } = deps;
    if (config.http.adapter !== 'fastify') {
        throw new Error(`Unsupported http.adapter: ${config.http.adapter}`);
    }
    const adapter = new FastifyHttpAdapter({ logger });
    const security = createSecurityGuard(config.security);
    const server = {
        adapter,
        security,
        registerRoute(method, path, handler, options) {
            adapter.registerRoute(method, path, security.wrap(handler), options);
        },
        registerMiddleware(middleware) {
            adapter.registerMiddleware(middleware);
        },
        async start() {
            await adapter.start(config.http.port, config.http.host);
            return { port: config.http.port, host: config.http.host };
        },
        async stop() {
            await adapter.stop();
        },
    };
    // Default routes — available without any user route registration.
    server.registerRoute('GET', '/health', createHealthRoute(version));
    server.registerRoute('GET', '/api/products', createProductsRoute(documentStore, config.store.name));
    return server;
}
//# sourceMappingURL=server.js.map