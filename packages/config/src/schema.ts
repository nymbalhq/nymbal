import { z } from 'zod'
import type { Slot } from '@nymbalhq/types'
import { BUILT_IN, PROVIDER_NAME, slotFolder } from './adapter-names.js'
import {
  COMMAND_STORES,
  REMOVED_INFRASTRUCTURE_KEYS,
  type InfrastructureSlot,
} from './known-infrastructure.js'
import { type CommerceSlot } from './known-providers.js'

const rateLimitRuleSchema = z.object({
  requests: z.number().int().positive(),
  window: z.string().regex(/^\d+(ms|s|m|h)$/, 'window must look like "60s", "5m", "1h"'),
  action: z.enum(['block', 'challenge', 'throttle']),
  /** Counts only the requests to the path that carry this header, such as `x-nymbal-order-email`. */
  header: z.string().min(1).optional(),
})

const rateLimitPathPattern = /^\/[\w\-/*:]*$/

/** The schema's JWT secret when none is configured: fine for development, refused in production. */
export const DEFAULT_JWT_SECRET = 'dev-secret-please-override-me-1234567890'

export const storeSchema = z.object({
  name: z.string().min(1),
  currency: z.string().length(3),
  locale: z.string().min(2),
  timezone: z.string().min(1),
  /** The storefront's public URL, which the order email links from; with none, the email has no link. */
  url: z
    .string()
    .url()
    .transform((url) => url.replace(/\/+$/, ''))
    .optional(),
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

/**
 * npm's rules for a new package name: lower case and URL-safe, optionally `@scope/`, never starting with `.` or `_`.
 * The 214-character limit is checked beside it.
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

const packageNameSchema = z
  .string()
  .max(214, 'an npm package name is at most 214 characters')
  .regex(NPM_PACKAGE_NAME, 'must be an npm package name, such as `@acme/nymbal-search`')

/** A provider name, refused with the value and the pattern when it is not one: it becomes part of a package name. */
function providerNameSchema(where: string) {
  return z.string().superRefine((value, ctx) => {
    if (!PROVIDER_NAME.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${where} '${value}' is not a provider name: a provider matches ${PROVIDER_NAME.source}`,
      })
    }
  })
}

/** How a slot's choice reads in a message: `payments.provider 'stripe'`, `infrastructure.media 's3'`. */
function choiceOf(slot: Slot, provider: string): string {
  if (slot === 'security') return `security.adapter '${provider}'`
  if (slot === 'documentStore' || slot === 'eventBus' || slot === 'media') {
    return `infrastructure.${slot} '${provider}'`
  }
  return `${slot}.provider '${provider}'`
}

/** `package` names a third party's adapter, which a built-in provider never is. */
function packageBesideBuiltIn(
  slot: Slot,
  block: { provider: string; package?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (block.package === undefined || !BUILT_IN[slot].includes(block.provider)) return
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['package'],
    message: `${choiceOf(slot, block.provider)} is built in, so it takes no package: delete package, or give the third-party adapter's own provider name beside it`,
  })
}

/** `custom` is the adapter passed to `createApp`, which only a commerce slot takes. */
function customOutsideCommerce(slot: Slot, provider: string, ctx: z.RefinementCtx): void {
  if (provider !== 'custom') return
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [slot === 'security' ? 'adapter' : 'provider'],
    message: `${choiceOf(slot, provider)}: only a commerce slot takes an adapter passed to createApp; name a third-party adapter with package: { provider: 'acme', package: '@acme/nymbal-${slotFolder(slot)}' }`,
  })
}

type BlockSlot = 'documentStore' | 'eventBus' | 'media'

/**
 * The providers whose connection the kernel builds itself, and what configures each: their block takes no `config`.
 * Any other provider gets the block's `config` as its adapter's `ctx.config`.
 */
const KERNEL_CONFIGURED: Readonly<Record<BlockSlot, Readonly<Record<string, string>>>> = {
  documentStore: {
    'in-memory': 'it is built in and takes none',
    redis: 'infrastructure.redis configures it',
    'postgres-jsonb': "it uses the command store's Postgres connection (DATABASE_URL)",
  },
  eventBus: {
    'in-process': 'it is built in and takes none',
    'redis-streams': 'infrastructure.redis configures it',
  },
  media: {
    'local-fs': 'it is built in and takes none',
    s3: 'infrastructure.s3 configures it',
  },
}

/** An infrastructure slot's block, `{ provider, package?, config? }`; a string is refused, saying how to write it. */
function infrastructureBlock(slot: BlockSlot) {
  return z
    .object(
      {
        provider: providerNameSchema(`infrastructure.${slot}`),
        /** The npm package the adapter comes from, in place of `@nymbalhq/<slot>-<provider>`. */
        package: packageNameSchema.optional(),
        /** The adapter's `ctx.config`, for a provider whose connection the kernel does not build. */
        config: z.record(z.string(), z.unknown()).optional(),
      },
      {
        errorMap: (issue, ctx) =>
          issue.code === z.ZodIssueCode.invalid_type && typeof ctx.data === 'string'
            ? {
                message: `infrastructure.${slot} takes a block: write { provider: '${ctx.data}' }`,
              }
            : { message: ctx.defaultError },
      },
    )
    .superRefine((block, ctx) => {
      customOutsideCommerce(slot, block.provider, ctx)
      packageBesideBuiltIn(slot, block, ctx)
      const configuredBy = Object.hasOwn(KERNEL_CONFIGURED[slot], block.provider)
        ? KERNEL_CONFIGURED[slot][block.provider]
        : undefined
      if (block.config !== undefined && configuredBy !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config'],
          message: `infrastructure.${slot} '${block.provider}' takes no config: ${configuredBy}`,
        })
      }
    })
}

const INFRASTRUCTURE_KEYS = ['commandStore', 'documentStore', 'eventBus', 'media', 'redis', 's3']

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
 * The bucket `media: { provider: 's3' }` stores in. Each field falls back to the environment in the platform;
 * credentials are never config keys: the AWS SDK's default chain provides them.
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
      commandStore: infrastructureValue('commandStore', COMMAND_STORES),
      documentStore: infrastructureBlock('documentStore'),
      eventBus: infrastructureBlock('eventBus'),
      media: infrastructureBlock('media').default({ provider: 'local-fs' }),
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
    if (infra.documentStore.provider === 'postgres-jsonb' && infra.commandStore !== 'postgres') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentStore'],
        message: `documentStore 'postgres-jsonb' shares the command store's Postgres connection, so it needs commandStore 'postgres' (not '${infra.commandStore}')`,
      })
    }
    if (
      infra.eventBus.provider === 'redis-streams' &&
      infra.documentStore.provider === 'in-memory'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventBus'],
        message: `eventBus 'redis-streams' needs a shared documentStore ('redis' or 'postgres-jsonb'), not 'in-memory': a named group hands each event to one instance, so a per-process read model would miss the rest`,
      })
    }
    if (infra.s3 !== undefined && infra.media.provider !== 's3') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['s3'],
        message: `infrastructure.s3 configures media 's3', but media is '${infra.media.provider}': set media to 's3' or delete the s3 block`,
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
  /** `middleware` is the kernel's own; any other resolves as a commerce provider does, `security-<adapter>`. */
  adapter: providerNameSchema('security.adapter'),
  /** The npm package the adapter comes from, in place of `@nymbalhq/security-<adapter>`. */
  package: packageNameSchema.optional(),
  /** A third-party adapter's `ctx.config`; `cloudflare` reads `security.cloudflare`, and `middleware` takes none. */
  config: z.record(z.string(), z.unknown()).optional(),
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
  customOutsideCommerce('security', security.adapter, ctx)
  packageBesideBuiltIn('security', { provider: security.adapter, package: security.package }, ctx)
  if (
    security.config !== undefined &&
    (security.adapter === 'middleware' || security.adapter === 'cloudflare')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['config'],
      message: `security.config is a third-party adapter's config; security.adapter '${security.adapter}' ${security.adapter === 'cloudflare' ? 'reads security.cloudflare' : 'takes none'}`,
    })
  }
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

/** A commerce slot's block: any provider name, the npm package it comes from, and the adapter's config. */
function adapterBlock(slot: CommerceSlot) {
  return z
    .object({
      provider: providerNameSchema(`${slot}.provider`),
      config: z.record(z.string(), z.unknown()).optional(),
      /**
       * The npm package the adapter comes from, in place of `@nymbalhq/<slot>-<provider>`. On a `custom` slot it is for
       * tooling (`nymbal test:contracts`): the kernel takes the adapter passed to `createApp` and imports nothing.
       */
      package: packageNameSchema.optional(),
    })
    .superRefine((block, ctx) => packageBesideBuiltIn(slot, block, ctx))
}

export const commerceSchema = z.object({
  payments: adapterBlock('payments'),
  email: adapterBlock('email'),
  reviews: adapterBlock('reviews'),
  search: adapterBlock('search'),
  analytics: adapterBlock('analytics'),
  shipping: adapterBlock('shipping'),
  tax: adapterBlock('tax'),
  ai: adapterBlock('ai'),
  orders: z
    .object({
      numberPrefix: z.string().min(1).default('NYM'),
      numberStart: z.number().int().nonnegative().default(1000),
      /** How long an order key opens the order on its own: the checkout's, and the order email's. */
      keyLifetime: z
        .object({
          checkout: z
            .string()
            .regex(/^\d+(ms|s|m|h|d)$/, 'TTL must look like "48h"')
            .default('48h'),
          email: z
            .string()
            .regex(/^\d+(ms|s|m|h|d)$/, 'TTL must look like "30d"')
            .default('30d'),
        })
        .default({}),
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

/**
 * The bucket delivered events past retention are archived to before they are deleted. Its objects hold customer
 * data, so it must be private: never the media bucket, which serves its objects publicly. Credentials come from the
 * AWS SDK's default chain, as `infrastructure.s3`'s do.
 */
export const eventArchiveSchema = z
  .object({
    adapter: z.literal('s3'),
    bucket: z.string().min(1),
    /** Where every archive key starts; none when not given. */
    prefix: z.string().optional(),
    /** `'us-east-1'` when not given. */
    region: z.string().min(1).optional(),
    /** An S3-compatible API (MinIO, R2). */
    endpoint: z.string().min(1).optional(),
    /** Path-style requests; true by default when an endpoint is set. */
    forcePathStyle: z.boolean().optional(),
  })
  .strict()

export const eventsSchema = z
  .object({
    /** Days a delivered event stays in the log. */
    retentionDays: z.number().int().min(1).default(30),
    archive: eventArchiveSchema.optional(),
  })
  .strict()

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
    events: eventsSchema.default({}),
  })
  .superRefine((cfg, ctx) => {
    const archiveBucket = cfg.events.archive?.bucket
    if (
      archiveBucket !== undefined &&
      cfg.infrastructure.media.provider === 's3' &&
      archiveBucket === cfg.infrastructure.s3?.bucket
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events', 'archive', 'bucket'],
        message: `events.archive.bucket is infrastructure.s3.bucket ('${archiveBucket}'), the media bucket, which serves its objects publicly; archive events to a private bucket of their own`,
      })
    }
    // SMTP left the kernel for @nymbalhq/email-smtp; a native block still asking for it would print to the console.
    const email = cfg.commerce.email
    if (email.provider === 'native' && email.config?.['transport'] === 'smtp') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commerce', 'email', 'config', 'transport'],
        message: `the native email provider only prints to the console; for SMTP mail set email.provider to 'smtp' (@nymbalhq/email-smtp)`,
      })
    }
  })

export type NymbalConfigInput = z.input<typeof nymbalConfigSchema>
export type NymbalConfig = z.output<typeof nymbalConfigSchema>
