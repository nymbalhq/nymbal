import { z } from 'zod'
import {
  KNOWN_INFRASTRUCTURE,
  REMOVED_INFRASTRUCTURE_KEYS,
  type InfrastructureSlot,
} from './known-infrastructure.js'
import { KNOWN_PROVIDERS, type CommerceSlot } from './known-providers.js'

const rateLimitRuleSchema = z.object({
  requests: z.number().int().positive(),
  window: z.string().regex(/^\d+(ms|s|m|h)$/, 'window must look like "60s", "5m", "1h"'),
  action: z.enum(['block', 'challenge', 'throttle']),
})

const rateLimitPathPattern = /^\/[\w\-/*:]*$/

/** The schema's JWT secret when none is configured: fine for development, refused in production. */
export const DEFAULT_JWT_SECRET = 'dev-secret-please-override-me-1234567890'

export const storeSchema = z.object({
  name: z.string().min(1),
  currency: z.string().length(3),
  locale: z.string().min(2),
  timezone: z.string().min(1),
})

const quotedList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ')

/** A slot's value must be one the slot lists; an unknown one is named with the list. */
function infrastructureValue<const V extends readonly [string, ...string[]]>(
  slot: InfrastructureSlot,
  values: V,
) {
  return z.enum(values, {
    errorMap: (issue, ctx) =>
      issue.code === z.ZodIssueCode.invalid_enum_value
        ? {
            message: `unknown ${slot} '${String(issue.received)}'; the ${slot} values are ${quotedList(values)}`,
          }
        : { message: ctx.defaultError },
  })
}

const INFRASTRUCTURE_KEYS = [...Object.keys(KNOWN_INFRASTRUCTURE), 'redis']

function unrecognizedInfrastructureKeys(keys: string[]): string {
  return keys
    .map((key) =>
      (REMOVED_INFRASTRUCTURE_KEYS as readonly string[]).includes(key)
        ? `infrastructure.${key} was removed: it drives nothing, so delete it from the config`
        : `unknown infrastructure key '${key}'; the infrastructure keys are ${quotedList(INFRASTRUCTURE_KEYS)}`,
    )
    .join('; ')
}

/** The shared Redis connection of the `redis` document store and the `redis-streams` bus. */
export const redisSchema = z
  .object({
    /** Defaults to `REDIS_URL`. */
    url: z.string().min(1).optional(),
    /** Namespaces every key and stream; defaults to `NYMBAL_REDIS_PREFIX`, then `'nymbal'`. */
    prefix: z.string().min(1).optional(),
    /** How long a publish waits for the groups it delivers to (default 15 000). */
    ackTimeoutMs: z.number().int().positive().optional(),
    /** How long an entry may stay pending on a consumer before a live one takes it over (default 5 000). */
    claimIdleMs: z.number().int().positive().optional(),
    /** The approximate length each stream is trimmed to (default 10 000). */
    streamMaxLen: z.number().int().positive().optional(),
  })
  .strict()

export const infrastructureSchema = z
  .object(
    {
      commandStore: infrastructureValue('commandStore', KNOWN_INFRASTRUCTURE.commandStore),
      documentStore: infrastructureValue('documentStore', KNOWN_INFRASTRUCTURE.documentStore),
      eventBus: infrastructureValue('eventBus', KNOWN_INFRASTRUCTURE.eventBus),
      media: infrastructureValue('media', KNOWN_INFRASTRUCTURE.media).default('local-fs'),
      redis: redisSchema.optional(),
    },
    {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? { message: unrecognizedInfrastructureKeys(issue.keys) }
          : { message: ctx.defaultError },
    },
  )
  .strict()
  .superRefine((infra, ctx) => {
    if (infra.documentStore === 'postgres-jsonb' && infra.commandStore !== 'postgres') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentStore'],
        message: `documentStore 'postgres-jsonb' shares the command store's Postgres connection, so it needs commandStore 'postgres' (not '${infra.commandStore}')`,
      })
    }
    if (infra.eventBus === 'redis-streams' && infra.documentStore === 'in-memory') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventBus'],
        message: `eventBus 'redis-streams' needs a shared documentStore ('redis' or 'postgres-jsonb'), not 'in-memory': a named group hands each event to one instance, so a per-process read model would miss the rest`,
      })
    }
  })

export const securitySchema = z.object({
  adapter: z.enum(['middleware', 'cloudflare', 'aws-waf', 'akamai']),
  rateLimit: z
    .record(
      z.string().regex(rateLimitPathPattern, {
        message: 'rate limit keys must start with "/" and use only letters, numbers, -, _, /, *, :',
      }),
      rateLimitRuleSchema,
    )
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
  auth: z
    .object({
      jwtSecret: z.string().min(16).default(DEFAULT_JWT_SECRET),
      accessTtl: z
        .string()
        .regex(/^\d+(ms|s|m|h|d)$/, 'TTL must look like "15m"')
        .default('15m'),
      refreshTtl: z
        .string()
        .regex(/^\d+(ms|s|m|h|d)$/, 'TTL must look like "7d"')
        .default('7d'),
    })
    .default({}),
})

/** A slot's block: its provider must be one the slot knows, and an unknown one is named with the slot's list. */
function adapterBlock<const P extends readonly [string, ...string[]]>(
  slot: CommerceSlot,
  providers: P,
) {
  const known = providers.map((p) => `'${p}'`).join(', ')
  return z.object({
    provider: z.enum(providers, {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.invalid_enum_value
          ? {
              message: `unknown ${slot} provider '${String(issue.received)}'; the ${slot} providers are ${known}`,
            }
          : { message: ctx.defaultError },
    }),
    config: z.record(z.string(), z.unknown()).optional(),
  })
}

export const commerceSchema = z.object({
  payments: adapterBlock('payments', KNOWN_PROVIDERS.payments),
  email: adapterBlock('email', KNOWN_PROVIDERS.email),
  reviews: adapterBlock('reviews', KNOWN_PROVIDERS.reviews),
  search: adapterBlock('search', KNOWN_PROVIDERS.search),
  analytics: adapterBlock('analytics', KNOWN_PROVIDERS.analytics),
  shipping: adapterBlock('shipping', KNOWN_PROVIDERS.shipping),
  tax: adapterBlock('tax', KNOWN_PROVIDERS.tax),
  ai: adapterBlock('ai', KNOWN_PROVIDERS.ai),
  orders: z
    .object({
      numberPrefix: z.string().min(1).default('NYM'),
      numberStart: z.number().int().nonnegative().default(1000),
    })
    .default({}),
})

export const httpSchema = z.object({
  adapter: z.enum(['fastify', 'hono']).default('fastify'),
  port: z.number().int().positive().default(3001),
  host: z.string().default('0.0.0.0'),
  /** Whether `X-Forwarded-For` sets the client IP the rate limiter keys on; only behind a proxy you run. */
  trustProxy: z.boolean().default(false),
  cors: z
    .object({
      allowedOrigins: z
        .array(z.string())
        .default(['http://localhost:3000', 'http://localhost:4321']),
      credentials: z.boolean().default(true),
    })
    .default({}),
})

export const deploymentSchema = z.object({
  strategy: z.enum(['standard', 'blue-green']).default('standard'),
})

export const featuresSchema = z.object({
  staging: z.boolean().default(false),
  heartbeat: z.boolean().default(false),
  autoUpdates: z.boolean().default(false),
})

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
    // SMTP left the kernel for @nymbalhq/adapter-smtp; a native block still asking for it would print to the console.
    const email = cfg.commerce.email
    if (email.provider === 'native' && email.config?.['transport'] === 'smtp') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commerce', 'email', 'config', 'transport'],
        message: `the native email provider only prints to the console; for SMTP mail set email.provider to 'smtp' (@nymbalhq/adapter-smtp)`,
      })
    }
  })

export type NymbalConfigInput = z.input<typeof nymbalConfigSchema>
export type NymbalConfig = z.output<typeof nymbalConfigSchema>
