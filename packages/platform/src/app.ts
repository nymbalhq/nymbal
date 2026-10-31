import { DEFAULT_JWT_SECRET, type NymbalConfig } from '@nymbalhq/config'
import {
  ConfigError,
  type CommerceSlot,
  type HealthReport,
  type PaymentsAdapter,
} from '@nymbalhq/types'
import { createPlatform, resolvePrimitives, type Platform } from './platform.js'
import type { ResolvePrimitivesOptions } from './platform.js'
import { buildRepositories, type Repositories } from './repositories/index.js'
import { rawClients } from './db/command-store.js'
import {
  buildAdapters,
  checkInjectedAdapters,
  COMMERCE_SLOTS,
  resolvePaymentsAdapter,
  resolveSecurityAdapter,
  type AdapterRegistry,
  type InjectedAdapters,
} from './adapters/registry.js'
import { isNotConfigured } from './adapters/not-configured.js'
import { createLogger } from './logger.js'
import { loadBootSettings } from './settings/load.js'
import { scrubbingLogger } from './settings/secret-set.js'
import { buildServices, type ServiceRegistry } from './services/index.js'
import { createEventPublisher, type EventPublisher } from './events/publisher.js'
import { createRelay, deliveringBus, type CreateRelayOptions, type Relay } from './events/relay.js'
import { createOutageProbe, type OutageSubject } from './events/outage.js'
import { registerHandlers } from './handlers/register.js'
import { READ_MODEL_NAMES, rebuild } from './read-models/index.js'
import {
  startInventoryReservationSweeper,
  startCartAbandonmentSweeper,
  startEventRetentionSweeper,
  type EventArchiveWriter,
  type SweeperHandle,
} from './sweepers/index.js'
import { importAdapterModule, resolveChoice } from './adapters/resolve.js'
import type { HttpAdapter } from '@nymbalhq/types'

export interface NymbalApp {
  platform: Platform
  repos: Repositories
  adapters: AdapterRegistry
  services: ServiceRegistry
  publisher: EventPublisher
  /** Delivers the event log to the bus; started by createApp, stopped by stop(). */
  relay: Relay
  /**
   * Registers the API on the adapter. The admin is served at /admin/ when `adminRoot` is passed (its dist directory,
   * or null for a 404 that says how to build it) or `NYMBAL_ADMIN_DIST` is set.
   */
  attachHttp(adapter: HttpAdapter, options?: AttachHttpOptions): Promise<void>
  /** Each slot's provider and its adapter's own `capabilities()`; an ai slot of `none` offers nothing. */
  capabilities(): CapabilitiesReport
  stop(): Promise<void>
}

export type CapabilitySlot = CommerceSlot | 'security' | 'documentStore' | 'eventBus' | 'media'

export interface SlotCapabilities {
  provider: string
  capabilities: readonly string[]
}

export type CapabilitiesReport = Record<CapabilitySlot, SlotCapabilities>

export interface AttachHttpOptions {
  adminRoot?: string | null
}

export interface CreateAppOptions extends ResolvePrimitivesOptions {
  version?: string
  /** The project's own adapters, one per slot whose provider is `custom`. */
  adapters?: InjectedAdapters
  /** How the event relay retries a failed delivery (`createRelay`). */
  relay?: Pick<CreateRelayOptions, 'maxAttempts' | 'retryDelayMs' | 'intervalMs' | 'now'>
}

/**
 * A production process must not run on the stub payments adapter (its unsigned webhook confirms any order) or sign
 * tokens with the schema's published default secret. Checked on the resolved adapter, built or injected, before
 * anything opens the store.
 */
function refuseUnsafeProduction(config: NymbalConfig, payments: PaymentsAdapter): void {
  if (process.env.NODE_ENV !== 'production') return
  const provider = config.commerce.payments.provider
  if (payments.providerName === 'native-stub') {
    throw new ConfigError(
      `Payments provider "${provider}" resolves to the stub adapter, which verifies no webhook signature; ` +
        'configure a real payments provider for production.',
      { code: 'config.production_stub_payments', context: { provider } },
    )
  }
  if (config.security.auth.jwtSecret === DEFAULT_JWT_SECRET) {
    throw new ConfigError(
      'security.auth.jwtSecret is the schema default; set a secret of your own for production.',
      { code: 'config.production_default_jwt_secret' },
    )
  }
}

type EventArchiveOptions = Omit<NonNullable<NymbalConfig['events']['archive']>, 'adapter'>

interface ObjectWriterModule {
  createS3ObjectWriter?: (options: EventArchiveOptions) => EventArchiveWriter
}

/**
 * The private object writer `events.archive` names, from `@nymbalhq/media-s3`, or undefined when no archive is set.
 * Its credentials come from the AWS SDK's default chain, as media's do.
 */
async function eventArchiveWriter(config: NymbalConfig): Promise<EventArchiveWriter | undefined> {
  const archive = config.events.archive
  if (archive === undefined) return undefined
  const { adapter, ...options } = archive
  let mod: ObjectWriterModule | undefined
  try {
    mod = (await importAdapterModule('media', { provider: adapter }, process.env)) as
      | ObjectWriterModule
      | undefined
  } catch (error) {
    if (!(error instanceof ConfigError && error.code === 'adapter.package_missing')) throw error
    throw new ConfigError(
      `events.archive needs @nymbalhq/media-s3: ${String(error.context['install'])}`,
      {
        code: 'adapter.package_missing',
        cause: error,
        context: error.context,
      },
    )
  }
  if (typeof mod?.createS3ObjectWriter !== 'function') {
    throw new ConfigError('@nymbalhq/media-s3 exports no createS3ObjectWriter; upgrade it', {
      code: 'adapter.package_invalid',
      context: { package: '@nymbalhq/media-s3' },
    })
  }
  return mod.createS3ObjectWriter(options)
}

interface Checkable {
  providerName?: unknown
  healthCheck?(): Promise<HealthReport>
}

/**
 * What the relay's outage probe checks: the primitives and every commerce slot a delivery can go through, each named
 * by its slot with the provider in the detail. Security and ai are left out (no delivery goes through either), and a
 * not-configured placeholder is too: it is down until a restart with its key, which is not an outage.
 */
function outageSubjects(
  config: NymbalConfig,
  platform: Platform,
  adapters: AdapterRegistry,
): OutageSubject[] {
  const subject = (name: string, provider: string, adapter: Checkable): OutageSubject[] => {
    if (isNotConfigured(adapter)) return []
    if (typeof adapter.healthCheck !== 'function') return [{ name }]
    const check = adapter.healthCheck.bind(adapter)
    const named = (detail: string | undefined) => (detail ? `${provider}: ${detail}` : provider)
    return [
      {
        name,
        healthCheck: () =>
          Promise.resolve()
            .then(check)
            .then(
              (report) =>
                report.status === 'down' ? { ...report, detail: named(report.detail) } : report,
              (err: unknown) => {
                throw new Error(named(err instanceof Error ? err.message : String(err)))
              },
            ),
      },
    ]
  }
  const { infrastructure } = config
  return [
    ...subject('eventBus', infrastructure.eventBus.provider, platform.eventBus),
    ...subject('documentStore', infrastructure.documentStore.provider, platform.documentStore),
    ...subject('media', infrastructure.media.provider, platform.media),
    ...COMMERCE_SLOTS.filter((slot) => slot !== 'ai').flatMap((slot) => {
      const adapter = adapters[slot] as Checkable
      const provider =
        typeof adapter.providerName === 'string'
          ? adapter.providerName
          : config.commerce[slot].provider
      return subject(slot, provider, adapter)
    }),
  ]
}

export async function createApp(
  config: NymbalConfig,
  options: CreateAppOptions = {},
): Promise<NymbalApp> {
  // Whatever logger the caller gives, nothing it writes carries a secret Settings hold.
  const logger = scrubbingLogger(
    options.logger ?? createLogger({ base: { store: config.store.name } }),
  )
  const adapterLogger = logger.child({ layer: 'adapter' })
  checkInjectedAdapters(config, options.adapters)
  // Settings are read, through a read-only open closed again here, before any adapter is built: payments first.
  const settings = await loadBootSettings(config, {
    storage: {
      ...(options.sqlitePath !== undefined && { sqlitePath: options.sqlitePath }),
      ...(options.postgresUrl !== undefined && { postgresUrl: options.postgresUrl }),
    },
    env: process.env,
    logger,
  })
  const payments = await resolvePaymentsAdapter(
    config,
    adapterLogger,
    options.adapters,
    settings.values,
  )
  refuseUnsafeProduction(config, payments)
  const security = await resolveSecurityAdapter(config, adapterLogger)
  const archive = await eventArchiveWriter(config)
  const primitives = await resolvePrimitives(config, { ...options, logger })
  // Until the app is returned, nothing else holds the connections the primitives and the command store open.
  let release = async (): Promise<void> => {
    await primitives.eventBus.close()
    await primitives.documentStore.close()
  }
  try {
    const platform = createPlatform(config, { ...options, ...primitives, logger })
    release = () => platform.close()
    const version = options.version ?? '0.1.0'

    const repos = buildRepositories(platform.commandStore, platform.documentStore)
    const adapters = await buildAdapters({
      config,
      logger: adapterLogger,
      sql: rawClients(platform.commandStore),
      repos,
      payments,
      security,
      settings: settings.values,
      ...(options.adapters !== undefined && { injected: options.adapters }),
    })
    const relay = createRelay({
      store: platform.commandStore,
      eventLog: repos.eventLog,
      eventBus: platform.eventBus,
      logger,
      outage: createOutageProbe(outageSubjects(config, platform, adapters)),
      ...options.relay,
    })
    const subscriberBus = deliveringBus(platform.eventBus, relay)
    const publisher = createEventPublisher({
      eventBus: platform.eventBus,
      store: platform.commandStore,
      eventLog: repos.eventLog,
      relay,
      builderContext: {
        storeId: config.store.name,
        environment:
          process.env.NODE_ENV === 'production'
            ? 'production'
            : process.env.NODE_ENV === 'staging'
              ? 'staging'
              : 'development',
        version,
        source: 'nymbal-app',
      },
    })
    const services = buildServices({
      config,
      store: platform.commandStore,
      repos,
      publisher,
      logger: logger.child({ layer: 'service' }),
      payments: adapters.payments,
      searchAdapter: adapters.search,
      email: adapters.email,
    })

    await registerHandlers({
      config,
      eventBus: subscriberBus,
      documentStore: platform.documentStore,
      repos,
      adapters,
      alerts: services.alert,
      orders: services.order,
      logger,
    })

    // Every read model is rebuilt from the tables before anything is served, so a fresh process serves what a
    // long-running one does. A search index in a package lives outside the process and outlasts it: a restart would
    // only upload the catalogue again, so live events and `nymbal replay --to search` fill it instead.
    const externalSearch = resolveChoice('search', config.commerce.search).kind === 'package'
    await rebuild(
      externalSearch ? READ_MODEL_NAMES.filter((name) => name !== 'search') : READ_MODEL_NAMES,
      {
        config,
        store: platform.commandStore,
        repos,
        documentStore: platform.documentStore,
        search: adapters.search,
        logger,
      },
    )

    // Events committed before a crash, or whose delivery failed, go out before the app serves anything.
    await relay.drain()
    relay.start()

    const sweepers: SweeperHandle[] = [
      startInventoryReservationSweeper({
        inventoryService: services.inventory,
        reservationRepo: repos.inventoryReservation,
        logger,
      }),
      startCartAbandonmentSweeper({
        store: platform.commandStore,
        carts: repos.cart,
        publisher,
        logger,
      }),
      startEventRetentionSweeper({
        store: platform.commandStore,
        eventLog: repos.eventLog,
        processedEvents: repos.processedEvent,
        logger,
        retentionDays: config.events.retentionDays,
        ...(archive !== undefined && { archive }),
      }),
    ]

    const app: NymbalApp = {
      platform,
      repos,
      adapters,
      services,
      publisher,
      relay,
      async attachHttp(adapter, options = {}) {
        await adapters.security.applyMiddleware(adapter, config.security)
        const { registerAllRoutes } = await import('./routes/register.js')
        registerAllRoutes({
          config,
          adapter,
          services,
          adapters,
          repos,
          documentStore: platform.documentStore,
          eventBus: subscriberBus,
          publisher,
          settingsSlots: settings.slots,
          adminRoot:
            options.adminRoot !== undefined ? options.adminRoot : process.env['NYMBAL_ADMIN_DIST'],
        })
      },
      capabilities() {
        const commerce = Object.fromEntries(
          COMMERCE_SLOTS.map((slot) => {
            const adapter = adapters[slot]
            return [
              slot,
              {
                provider: config.commerce[slot].provider,
                capabilities: adapter === null ? [] : adapter.capabilities(),
              },
            ]
          }),
        ) as Record<CommerceSlot, SlotCapabilities>
        return {
          ...commerce,
          security: {
            provider: config.security.adapter,
            capabilities: adapters.security.capabilities(),
          },
          documentStore: {
            provider: config.infrastructure.documentStore.provider,
            capabilities: platform.documentStore.capabilities(),
          },
          eventBus: {
            provider: config.infrastructure.eventBus.provider,
            capabilities: platform.eventBus.capabilities(),
          },
          media: {
            provider: config.infrastructure.media.provider,
            capabilities: platform.media.capabilities(),
          },
        }
      },
      async stop() {
        await relay.stop()
        for (const s of sweepers) s.stop()
        await platform.close()
      },
    }
    return app
  } catch (error) {
    await release().catch((err: unknown) =>
      logger.error({ err }, 'closing the primitives after a failed start failed'),
    )
    throw error
  }
}
