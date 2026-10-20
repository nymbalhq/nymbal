import { join } from 'node:path'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  ConfigError,
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type Logger,
  type MediaStorage,
} from '@nymbalhq/types'
import { loadProviderAdapter } from './adapters/loader.js'
import { createCommandStore, type CommandStore } from './db/command-store.js'
import { InMemoryDocumentStore } from './document-store/in-memory.js'
import { InProcessEventBus } from './event-bus/in-process.js'
import { createLogger } from './logger.js'
import { createLocalFsMediaStorage } from './media/index.js'

export interface Platform {
  config: NymbalConfig
  commandStore: CommandStore
  documentStore: DocumentStoreAdapter
  eventBus: EventBusAdapter
  media: MediaStorage
  logger: Logger
  close(): Promise<void>
}

/** Where the command store is, and the logger; what `createApp` and `resolvePrimitives` take as well. */
export interface PlatformConnectionOptions {
  logger?: Logger
  sqlitePath?: string
  postgresUrl?: string
}

/** The infrastructure primitives, as instances: `resolvePrimitives` builds them from the config. */
export interface Primitives {
  documentStore: DocumentStoreAdapter
  eventBus: EventBusAdapter
  media: MediaStorage
}

export interface CreatePlatformOptions extends PlatformConnectionOptions, Primitives {}

export interface ResolvePrimitivesOptions extends PlatformConnectionOptions {
  /** Where local-fs media is written; `public/imported-media` under the working directory by default. */
  mediaRoot?: string
  env?: NodeJS.ProcessEnv
}

export const REDIS_DEFAULTS = {
  prefix: 'nymbal',
  ackTimeoutMs: 15_000,
  claimIdleMs: 5_000,
  streamMaxLen: 10_000,
} as const

/** The Postgres JSONB store's namespace inside the command store's database. */
const JSONB_PREFIX = 'nymbal'

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** The `redis` block with its defaults: the URL from `REDIS_URL`, the prefix from `NYMBAL_REDIS_PREFIX`. */
function redisConnection(config: NymbalConfig, env: NodeJS.ProcessEnv, slot: string) {
  const block = config.infrastructure.redis ?? {}
  const url = block.url ?? nonEmpty(env['REDIS_URL'])
  if (url === undefined) {
    throw new ConfigError(
      `infrastructure.${slot} needs a Redis server: set infrastructure.redis.url or REDIS_URL`,
      { code: 'config.redis_url_missing', context: { slot } },
    )
  }
  return {
    url,
    prefix: block.prefix ?? nonEmpty(env['NYMBAL_REDIS_PREFIX']) ?? REDIS_DEFAULTS.prefix,
    ackTimeoutMs: block.ackTimeoutMs ?? REDIS_DEFAULTS.ackTimeoutMs,
    claimIdleMs: block.claimIdleMs ?? REDIS_DEFAULTS.claimIdleMs,
    streamMaxLen: block.streamMaxLen ?? REDIS_DEFAULTS.streamMaxLen,
  }
}

async function loadPrimitive<T>(
  slot: 'documentStore' | 'eventBus',
  provider: string,
  config: Record<string, unknown>,
  logger: Logger,
  env: NodeJS.ProcessEnv,
): Promise<T> {
  const instance = await loadProviderAdapter(slot, provider, {
    config,
    logger: logger.child({ primitive: slot }),
    env,
  })
  if (instance === undefined) {
    throw new ConfigError(`infrastructure.${slot} '${provider}' has no implementation`, {
      context: { slot, provider },
    })
  }
  return instance as T
}

async function resolveDocumentStore(
  config: NymbalConfig,
  options: ResolvePrimitivesOptions,
  logger: Logger,
  env: NodeJS.ProcessEnv,
): Promise<DocumentStoreAdapter> {
  const choice = config.infrastructure.documentStore
  switch (choice) {
    case 'in-memory':
      return new InMemoryDocumentStore()
    case 'redis': {
      const { url, prefix } = redisConnection(config, env, 'documentStore')
      return loadPrimitive('documentStore', choice, { url, prefix }, logger, env)
    }
    case 'postgres-jsonb': {
      const postgresUrl = options.postgresUrl ?? nonEmpty(env['DATABASE_URL'])
      if (postgresUrl === undefined) {
        throw new ConfigError(
          "documentStore 'postgres-jsonb' uses the command store's Postgres: set DATABASE_URL (or pass postgresUrl)",
          { code: 'config.postgres_url_missing', context: { slot: 'documentStore' } },
        )
      }
      const store = await loadPrimitive<DocumentStoreAdapter & { initialize?(): Promise<void> }>(
        'documentStore',
        choice,
        { postgresUrl, prefix: JSONB_PREFIX },
        logger,
        env,
      )
      try {
        await store.initialize?.()
      } catch (error) {
        await store.close()
        throw error
      }
      return store
    }
    default: {
      const exhaustive: never = choice
      throw new ConfigError(`Unknown documentStore: ${String(exhaustive)}`)
    }
  }
}

async function resolveEventBus(
  config: NymbalConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv,
): Promise<EventBusAdapter> {
  const choice = config.infrastructure.eventBus
  switch (choice) {
    case 'in-process':
      return new InProcessEventBus({ logger })
    case 'redis-streams':
      return loadPrimitive(
        'eventBus',
        choice,
        redisConnection(config, env, 'eventBus'),
        logger,
        env,
      )
    default: {
      const exhaustive: never = choice
      throw new ConfigError(`Unknown eventBus: ${String(exhaustive)}`)
    }
  }
}

function resolveMedia(config: NymbalConfig, options: ResolvePrimitivesOptions): MediaStorage {
  const choice = config.infrastructure.media
  switch (choice) {
    case 'local-fs':
      return createLocalFsMediaStorage({
        root: options.mediaRoot ?? join(process.cwd(), 'public', 'imported-media'),
        urlPrefix: '/imported-media',
      })
    default: {
      const exhaustive: never = choice
      throw new ConfigError(`Unknown media: ${String(exhaustive)}`)
    }
  }
}

/**
 * The document store, event bus and media storage the config names. A primitive that lives in its own package is
 * imported only when named; a missing package fails `adapter.package_missing` with the install line.
 */
export async function resolvePrimitives(
  config: NymbalConfig,
  options: ResolvePrimitivesOptions = {},
): Promise<Primitives> {
  const env = options.env ?? process.env
  const logger = options.logger ?? createLogger({ base: { store: config.store.name } })
  const media = resolveMedia(config, options)
  // Checked before anything connects, so a missing URL never leaves a half-built set behind.
  if (config.infrastructure.documentStore === 'redis') redisConnection(config, env, 'documentStore')
  if (config.infrastructure.eventBus === 'redis-streams') redisConnection(config, env, 'eventBus')
  const documentStore = await resolveDocumentStore(config, options, logger, env)
  try {
    const eventBus = await resolveEventBus(config, logger, env)
    return { documentStore, eventBus, media }
  } catch (error) {
    await documentStore.close()
    throw error
  }
}

export function createPlatform(config: NymbalConfig, options: CreatePlatformOptions): Platform {
  const logger =
    options.logger ??
    createLogger({
      base: { store: config.store.name },
    })
  const commandStore = createCommandStore(config, {
    ...(options.sqlitePath !== undefined && { sqlitePath: options.sqlitePath }),
    ...(options.postgresUrl !== undefined && { postgresUrl: options.postgresUrl }),
  })
  const { documentStore, eventBus, media } = options
  return {
    config,
    commandStore,
    documentStore,
    eventBus,
    media,
    logger,
    async close() {
      // The bus first: a handler still running may write to either store.
      await eventBus.close()
      await documentStore.close()
      await commandStore.close()
    },
  }
}
