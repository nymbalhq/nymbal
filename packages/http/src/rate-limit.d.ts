import type { RateLimitAction } from '@nymbal/types';
export interface ParsedRule {
    pattern: string;
    regex: RegExp;
    requests: number;
    windowMs: number;
    action: RateLimitAction;
}
export declare class RateLimiter {
    #private;
    constructor(rules: Record<string, {
        requests: number;
        window: string;
        action: RateLimitAction;
    }>);
    check(ip: string, path: string): {
        allowed: boolean;
        action: RateLimitAction;
        retryAfter?: number;
    } | null;
    reset(): void;
}
//# sourceMappingURL=rate-limit.d.ts.map