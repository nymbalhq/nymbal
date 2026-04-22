import type { NymbalConfig } from '@nymbal/config';
import type { DocumentStoreAdapter, HttpAdapter, HttpMethod, Logger, MiddlewareHandler, RouteHandler, RouteOptions } from '@nymbal/types';
import { type SecurityGuard } from './security-middleware.js';
export interface HttpServerDeps {
    config: NymbalConfig;
    logger: Logger;
    documentStore: DocumentStoreAdapter;
    version: string;
}
export interface HttpServer {
    adapter: HttpAdapter;
    security: SecurityGuard;
    registerRoute(method: HttpMethod, path: string, handler: RouteHandler, options?: RouteOptions): void;
    registerMiddleware(middleware: MiddlewareHandler): void;
    start(): Promise<{
        port: number;
        host: string;
    }>;
    stop(): Promise<void>;
}
export declare function createHttpServer(deps: HttpServerDeps): HttpServer;
//# sourceMappingURL=server.d.ts.map