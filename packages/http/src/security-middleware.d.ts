import type { NymbalConfig } from '@nymbal/config';
import type { RouteHandler } from '@nymbal/types';
export declare const CSRF_COOKIE = "nymbal.csrf";
export declare const CSRF_HEADER = "x-csrf-token";
export declare function buildSecurityHeaders(security: NymbalConfig['security']): Record<string, string>;
export interface SecurityGuard {
    wrap(handler: RouteHandler): RouteHandler;
    reset(): void;
}
export declare function createSecurityGuard(security: NymbalConfig['security']): SecurityGuard;
//# sourceMappingURL=security-middleware.d.ts.map