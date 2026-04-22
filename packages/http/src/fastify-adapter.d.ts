import type { HttpAdapter, HttpMethod, Logger, MiddlewareHandler, RouteHandler, RouteOptions } from '@nymbal/types';
export interface FastifyAdapterOptions {
    logger: Logger;
    trustProxy?: boolean;
}
export declare class FastifyHttpAdapter implements HttpAdapter {
    #private;
    constructor(options: FastifyAdapterOptions);
    registerRoute(method: HttpMethod, path: string, handler: RouteHandler, options?: RouteOptions): void;
    registerMiddleware(middleware: MiddlewareHandler): void;
    start(port: number, host?: string): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=fastify-adapter.d.ts.map