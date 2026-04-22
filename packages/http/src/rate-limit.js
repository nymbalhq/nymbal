export class RateLimiter {
    #rules;
    #buckets = new Map();
    constructor(rules) {
        this.#rules = Object.entries(rules).map(([pattern, rule]) => ({
            pattern,
            regex: compilePathPattern(pattern),
            requests: rule.requests,
            windowMs: parseWindow(rule.window),
            action: rule.action,
        }));
    }
    check(ip, path) {
        const rule = this.#rules.find((r) => r.regex.test(path));
        if (!rule)
            return null;
        const key = `${rule.pattern}|${ip}`;
        const now = Date.now();
        const bucket = this.#buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            this.#buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
            return { allowed: true, action: rule.action };
        }
        bucket.count += 1;
        if (bucket.count > rule.requests) {
            return {
                allowed: false,
                action: rule.action,
                retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
            };
        }
        return { allowed: true, action: rule.action };
    }
    reset() {
        this.#buckets.clear();
    }
}
function parseWindow(window) {
    const match = /^(\d+)(ms|s|m|h)$/.exec(window);
    if (!match)
        throw new Error(`Invalid rate-limit window: ${window}`);
    const n = Number(match[1]);
    switch (match[2]) {
        case 'ms':
            return n;
        case 's':
            return n * 1000;
        case 'm':
            return n * 60_000;
        case 'h':
            return n * 3_600_000;
        default:
            throw new Error(`Unreachable unit: ${match[2]}`);
    }
}
function compilePathPattern(pattern) {
    const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLESTAR__')
        .replace(/\*/g, '[^/]+')
        .replace(/__DOUBLESTAR__/g, '.*');
    return new RegExp(`^${escaped}$`);
}
//# sourceMappingURL=rate-limit.js.map