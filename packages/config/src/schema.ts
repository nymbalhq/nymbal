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

const INFRASTRUCTURE_KEYS = [...Object.keys(KNOWN_INFRASTRUCTURE), 'redis', 's3']

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

const S3_KEYS = ['bucket', 'region', 'endpoint', 'prefix', 'publicUrl', 'forcePathStyle']

/**
 * The bucket `media: 's3'` stores in. Each field falls back to the environment in the platform; credentials are never
 * config keys: the AWS SDK's default chain provides them.
 */
export const s3Schema = z
  .object(
    {
      /** Defaults to `S3_BUCKET`; one of the two is required. */
      bucket: z.string().min(1).optional(),
      /** Defaults to `AWS_REGION`, then `'us-east-1'`. */
      region: z.string().min(1).optional(),
      /** An S3-compatible API (MinIO, R2); defaults to `S3_ENDPOINT`, then AWS. */
      endpoint: z.string().min(1).optional(),
      /** Where every object key starts; defaults to `NYMBAL_S3_PREFIX`, then none. */
      prefix: z.string().optional(),
      /** Where the bucket's objects are served from (a CDN); defaults to `S3_PUBLIC_URL`, then the bucket's own URL. */
      publicUrl: z.string().min(1).optional(),
      /** Path-style requests; true by default when an endpoint is set. */
      forcePathStyle: z.boolean().optional(),
    },
    {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? {
              message: `unknown infrastructure.s3 key${issue.keys.length > 1 ? 's' : ''} ${quotedList(issue.keys)}; the s3 keys are ${quotedList(S3_KEYS)}, and credentials come from the AWS SDK (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, a profile or a role), never the config`,
            }
          : { message: ctx.defaultError },
    },
  )
  .strict()

export const infrastructureSchema = z
  .object(
    {
      commandStore: infrastructureValue('commandStore', KNOWN_INFRASTRUCTURE.commandStore),
      documentStore: infrastructureValue('documentStore', KNOWN_INFRASTRUCTURE.documentStore),
      eventBus: infrastructureValue('eventBus', KNOWN_INFRASTRUCTURE.eventBus),
      media: infrastructureValue('media', KNOWN_INFRASTRUCTURE.media).default('local-fs'),
      redis: redisSchema.optional(),
      s3: s3Schema.optional(),
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
    if (infra.s3 !== undefined && infra.media !== 's3') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['s3'],
        message: `infrastructure.s3 configures media 's3', but media is '${infra.media}': set media to 's3' or delete the s3 block`,
      })
    }
  })

/** Where a `cloudflare` store's rules go: required when `security.adapter` is `cloudflare`, read with `env()`. */
const cloudflareSchema = z.object({
  zoneId: z.string().optional(),
  apiToken: z.string().optional(),
  /** The Cloudflare v4 API; the adapter defaults it to https://api.cloudflare.com/client/v4. */
  apiBase: z.string().url().optional(),
})

const customRuleSchema = z.object({
  name: z.string().min(1),
  expression: z.string().min(1),
  action: z.enum(['block', 'managed_challenge', 'js_challenge', 'log']),
})

const securityFields = z.object({
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
  cloudflare: cloudflareSchema.optional(),
  geo: z
    .object({
      block: z
        .array(z.string().regex(/^[A-Z]{2}$/, 'geo.block codes are ISO 3166 alpha-2, like "RU"'))
        .default([]),
    })
    .default({ block: [] }),
  customRules: z.array(customRuleSchema).default([]),
  managedRulesets: z.array(z.enum(['cloudflare', 'owasp'])).default([]),
})

export const securitySchema = securityFields.superRefine((security, ctx) => {
  if (security.adapter === 'cloudflare') {
    for (const field of ['zoneId', 'apiToken'] as const) {
      if (!security.cloudflare?.[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cloudflare', field],
          message: `security.adapter 'cloudflare' needs security.cloudflare.${field}`,
        })
      }
    }
  }
  const seen = new Set<string>()
  security.customRules.forEach((rule, i) => {
    if (seen.has(rule.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customRules', i, 'name'],
        message: `customRules has two rules named '${rule.name}'; names must be unique`,
      })
    }
    seen.add(rule.name)
  })
})

/**
 * npm's rules for a new package name: lower case and URL-safe, optionally `@scope/`, never starting with `.` or `_`.
 * The 214-character limit is checked beside it.
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

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
    /** The npm package a `custom` slot's adapter comes from, for tooling (`nymbal test:contracts`); the kernel never reads it. */
    package: z
      .string()
      .max(214, 'an npm package name is at most 214 characters')
      .regex(NPM_PACKAGE_NAME, 'must be an npm package name, such as `@acme/nymbal-search`')
      .optional(),
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
