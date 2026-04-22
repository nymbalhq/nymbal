import { z } from 'zod';
const rateLimitRuleSchema = z.object({
    requests: z.number().int().positive(),
    window: z.string().regex(/^\d+(ms|s|m|h)$/, 'window must look like "60s", "5m", "1h"'),
    action: z.enum(['block', 'challenge', 'throttle']),
});
const rateLimitPathPattern = /^\/[\w\-/*:]*$/;
export const storeSchema = z.object({
    name: z.string().min(1),
    currency: z.string().length(3),
    locale: z.string().min(2),
    timezone: z.string().min(1),
});
export const infrastructureSchema = z.object({
    cloud: z.enum(['local', 'aws', 'gcp', 'azure', 'docker']),
    commandStore: z.enum(['sqlite', 'postgres']),
    documentStore: z.enum([
        'in-memory',
        'dynamodb',
        'firestore',
        'cosmosdb',
        'postgres-jsonb',
    ]),
    eventBus: z.enum([
        'in-process',
        'eventbridge',
        'pubsub',
        'service-bus',
        'redis-streams',
    ]),
    compute: z.enum([
        'in-process',
        'lambda',
        'cloud-functions',
        'azure-functions',
        'worker-threads',
    ]),
});
export const securitySchema = z.object({
    adapter: z.enum(['middleware', 'cloudflare', 'aws-waf', 'akamai']),
    rateLimit: z
        .record(z.string().regex(rateLimitPathPattern, {
        message: 'rate limit keys must start with "/" and use only letters, numbers, -, _, /, *, :',
    }), rateLimitRuleSchema)
        .default({}),
    botProtection: z
        .object({
        mode: z.enum(['off', 'managed', 'strict']).default('off'),
        allowList: z.array(z.string()).default([]),
    })
        .default({ mode: 'off', allowList: [] }),
    headers: z
        .object({
        hsts: z.boolean().default(true),
        contentSecurityPolicy: z
            .union([z.enum(['strict', 'relaxed', 'off']), z.string()])
            .default('strict'),
        referrerPolicy: z.string().default('strict-origin-when-cross-origin'),
        xFrameOptions: z.enum(['deny', 'sameorigin']).default('deny'),
    })
        .default({}),
    csrf: z.boolean().default(true),
});
const adapterBlock = z.object({
    provider: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
});
export const commerceSchema = z.object({
    payments: adapterBlock,
    email: adapterBlock,
    reviews: adapterBlock,
    search: adapterBlock,
    analytics: adapterBlock,
    shipping: adapterBlock,
    tax: adapterBlock,
    ai: adapterBlock,
});
export const httpSchema = z.object({
    adapter: z.enum(['fastify', 'hono']).default('fastify'),
    port: z.number().int().positive().default(3001),
    host: z.string().default('0.0.0.0'),
});
export const deploymentSchema = z.object({
    strategy: z.enum(['standard', 'blue-green']).default('standard'),
});
export const featuresSchema = z.object({
    staging: z.boolean().default(false),
    heartbeat: z.boolean().default(false),
    autoUpdates: z.boolean().default(false),
});
export const nymbalConfigSchema = z
    .object({
    store: storeSchema,
    template: z.enum(['astro', 'nextjs']),
    infrastructure: infrastructureSchema,
    security: securitySchema,
    commerce: commerceSchema,
    http: httpSchema,
    deployment: deploymentSchema,
    features: featuresSchema.default({
        staging: false,
        heartbeat: false,
        autoUpdates: false,
    }),
})
    .superRefine((cfg, ctx) => {
    // Local infrastructure restricts which document-store / event-bus options make sense.
    if (cfg.infrastructure.cloud === 'local') {
        if (!['in-memory', 'postgres-jsonb'].includes(cfg.infrastructure.documentStore)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['infrastructure', 'documentStore'],
                message: `cloud=local only supports 'in-memory' or 'postgres-jsonb' for documentStore`,
            });
        }
        if (!['in-process', 'redis-streams'].includes(cfg.infrastructure.eventBus)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['infrastructure', 'eventBus'],
                message: `cloud=local only supports 'in-process' or 'redis-streams' for eventBus`,
            });
        }
        if (!['in-process', 'worker-threads'].includes(cfg.infrastructure.compute)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['infrastructure', 'compute'],
                message: `cloud=local only supports 'in-process' or 'worker-threads' for compute`,
            });
        }
    }
    // middleware security adapter is v0.1 and not intended for managed-cloud production deployments.
    if (cfg.security.adapter === 'middleware') {
        if (['aws', 'gcp', 'azure'].includes(cfg.infrastructure.cloud)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['security', 'adapter'],
                message: `security.adapter='middleware' is intended for local/docker development. Use a WAF adapter ('cloudflare', 'aws-waf', 'akamai') for cloud=${cfg.infrastructure.cloud}.`,
            });
        }
    }
});
//# sourceMappingURL=schema.js.map