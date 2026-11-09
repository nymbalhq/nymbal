import {
  DEFAULT_CUSTOMER_FIELDS,
  DEFAULT_JWT_SECRET,
  resolveOriginLock,
  resolveTrustedProxies,
  type NymbalConfig,
} from '@nymbalhq/config'
import {
  ConfigError,
  type CommerceSlot,
  type HealthReport,
  type PaymentsAdapter,
  type ResolvedNetwork,
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
import { addSecret, scrubbingLogger } from './settings/secret-set.js'
import { isLoopbackHost, JWT_SECRET_ENV, resolveAuthSecret } from './auth-secret.js'
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
  startRefreshTokenSweeper,
  startStuckProposalSweeper,
  type EventArchiveWriter,
  type SweeperHandle,
} from './sweepers/index.js'
import { importAdapterModule, resolveChoice } from './adapters/resolve.js'
import type { AgentSurfaces, HttpAdapter, ToolSurface } from '@nymbalhq/types'
import { RouteTable, recordingAdapter } from './mcp/route-table.js'
import { toolsOf } from './mcp/registry.js'
import { createInvoker, type Invoker } from './mcp/invoke.js'
import { policyOf } from './mcp/proposals.js'
import { createAgentSurfaces } from './agents/surfaces.js'
import { resolveAcpSettings } from './agents/acp/settings.js'
import { idempotentCommand } from './audit/idempotency.js'
import { runAsActor, type Actor } from './audit/actor.js'

export interface NymbalApp {
  platform: Platform
  repos: Repositories
  adapters: AdapterRegistry
  services: ServiceRegistry
  publisher: EventPublisher
  /** Delivers the event log to the bus; started by createApp, stopped by stop(). */
  relay: Relay
  /**
   * The trusted proxies, client-address header and origin lock, resolved once from the environment, the config and the
   * security adapter's contribution: the block every HTTP server for this app is built with.
   */
  network: ResolvedNetwork
  /**
   * Registers the API on the adapter. The admin is served at /admin/ when `adminRoot` is passed (its dist directory,
   * or null for a 404 that says how to build it) or `NYMBAL_ADMIN_DIST` is set.
   */
  attachHttp(adapter: HttpAdapter, options?: AttachHttpOptions): Promise<void>
  /** The API's routes as agent tools, run in process through the handlers `attachHttp` registered; set by it. */
  readonly mcp: ToolSurface | undefined
  /** The routes as the admin's assistant runs them: as `mcp`, but only `agents.autoApprove` applies a write. */
  readonly assistantTools: ToolSurface | undefined
  /** The agent surfaces (UCP) and crawl files, over `mcp`; set by `attachHttp` once `mcp` is. */
  readonly agents: AgentSurfaces | undefined
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
  /** How often expired and used refresh tokens are deleted; tests shorten it. */
  refreshTokenSweep?: { intervalMs?: number }
  /** How often approved proposals that never settled are swept, and after how long they count; tests shorten both. */
  proposalSweep?: { intervalMs?: number; stuckAfterMs?: number }
}

/** Who an ACP agent's keyed requests are recorded as: the agent's own name is a label anyone holding the key can set. */
const ACP_ACTOR: Actor = { kind: 'system', id: 'acp' }

/**
 * A production process must not run on the stub payments adapter (its unsigned webhook confirms any order) or sign
 * tokens with the schema's published default secret. Checked on the resolved adapter, built or injected, and the
 * effective secret, before anything opens the store.
 */
function refuseUnsafeProduction(
  config: NymbalConfig,
  payments: PaymentsAdapter,
  jwtSecret: string,
): void {
  if (process.env.NODE_ENV !== 'production') return
  const provider = config.commerce.payments.provider
  if (payments.providerName === 'native-stub') {
    throw new ConfigError(
      `Payments provider "${provider}" resolves to the stub adapter, which verifies no webhook signature; ` +
        'configure a real payments provider for production.',
      { code: 'config.production_stub_payments', context: { provider } },
    )
  }
  if (jwtSecret === DEFAULT_JWT_SECRET) {
    throw new ConfigError(
      `security.auth.jwtSecret is the schema default and ${JWT_SECRET_ENV} is not set; set either to a secret of your own for production.`,
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
  const policy = policyOf(config.agents)
  // The admin's assistant is not an MCP client: `agents.mcp.writes: 'apply'` never applies what it asks for.
  const assistantPolicy = policyOf({
    ...config.agents,
    mcp: { ...config.agents.mcp, writes: 'proposal' },
  })
  const jwt = resolveAuthSecret(config, process.env)
  addSecret(jwt.secret)
  const shadowed = process.env[JWT_SECRET_ENV]
  if (jwt.source === 'config' && shadowed !== undefined && shadowed !== jwt.secret) {
    logger.warn(
      { variable: JWT_SECRET_ENV },
      `security.auth.jwtSecret in the config is used; ${JWT_SECRET_ENV} is set and ignored`,
    )
  }
  if (process.env.NODE_ENV === 'production' && jwt.secret.length < 32) {
    logger.warn(
      { source: jwt.source },
      'the JWT secret is shorter than 32 characters; HS256 wants 256 bits (`openssl rand -base64 32`)',
    )
  }
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
  refuseUnsafeProduction(config, payments, jwt.secret)
  const security = await resolveSecurityAdapter(config, adapterLogger)
  const originLock = resolveOriginLock(config, process.env)
  const network: ResolvedNetwork = {
    ...resolveTrustedProxies(config, process.env, {
      adapter: config.security.adapter,
      network: security.network?.() ?? {},
    }),
    ...(originLock !== undefined && { originLock }),
  }
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
    let mcp: Invoker | undefined
    let assistantTools: Invoker | undefined
    const services = buildServices({
      config,
      store: platform.commandStore,
      repos,
      publisher,
      logger: logger.child({ layer: 'service' }),
      payments: adapters.payments,
      searchAdapter: adapters.search,
      email: adapters.email,
      reviews: adapters.reviews,
      jwtSecret: jwt.secret,
      executeProposal: (row, auth) => {
        if (mcp === undefined)
          throw new Error('a proposal runs through the routes attachHttp registers')
        return mcp.execute(row, auth)
      },
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
      startRefreshTokenSweeper({
        store: platform.commandStore,
        refreshTokens: repos.refreshToken,
        logger,
        ...(options.refreshTokenSweep?.intervalMs !== undefined && {
          intervalMs: options.refreshTokenSweep.intervalMs,
        }),
      }),
      startStuckProposalSweeper({
        store: platform.commandStore,
        proposals: repos.proposal,
        publisher,
        logger,
        ...options.proposalSweep,
      }),
    ]

    let agents: AgentSurfaces | undefined
    const app: NymbalApp = {
      platform,
      repos,
      adapters,
      services,
      publisher,
      relay,
      network,
      async attachHttp(adapter, options = {}) {
        // Anyone can sign a token with the published default secret, so it is served on loopback only.
        if (jwt.source === 'default' && !isLoopbackHost(config.http.host)) {
          throw new ConfigError(
            `security.auth.jwtSecret is the schema default and ${JWT_SECRET_ENV} is not set, so the API may listen on loopback only, not on ${config.http.host}; set ${JWT_SECRET_ENV} to a secret of your own (\`openssl rand -base64 32\`).`,
            { code: 'config.default_jwt_secret_exposed', context: { host: config.http.host } },
          )
        }
        const acp = resolveAcpSettings(config, adapters.payments)
        if (acp !== null) {
          addSecret(acp.apiKey)
          logger.warn(
            {},
            'agents.acp is on: Agentic Commerce Protocol checkout is beta, and its API may change',
          )
        }
        await adapters.security.applyMiddleware(adapter, config.security)
        const { registerAllRoutes } = await import('./routes/register.js')
        const table = new RouteTable()
        registerAllRoutes({
          config,
          adapter: recordingAdapter(table, adapter),
          services,
          adapters,
          repos,
          documentStore: platform.documentStore,
          eventBus: subscriberBus,
          publisher,
          settingsSlots: settings.slots,
          jwtSecret: jwt.secret,
          adminRoot:
            options.adminRoot !== undefined ? options.adminRoot : process.env['NYMBAL_ADMIN_DIST'],
          assistantTools: () => assistantTools,
        })
        const tools = toolsOf(table)
        mcp = createInvoker({
          table,
          tools,
          proposals: services.proposals,
          policy,
          logger,
          // A config the schema never parsed (as tests build one) withholds the default too.
          withhold:
            (config.agents.mcp as Partial<typeof config.agents.mcp>).withhold ??
            DEFAULT_CUSTOMER_FIELDS,
        })
        // The assistant reads every value: its own mask mints the placeholders and reveals them to the admin.
        assistantTools = createInvoker({
          table,
          tools,
          proposals: services.proposals,
          policy: assistantPolicy,
          logger,
          withhold: [],
        })
        agents = createAgentSurfaces({
          config,
          mcp,
          variants: (variantId) =>
            platform.commandStore.read(async (tx) => {
              const variant = await repos.variant.findById(tx, variantId)
              if (variant === null) return null
              return (await repos.product.findById(tx, variant.productId))?.slug ?? null
            }),
          // A cart a customer has claimed is theirs, no longer the agent's to read or hand on.
          cart: async (token) => {
            const cart = await services.cart.get(token)
            return cart === null || cart.customerId === null ? cart : null
          },
          ...(acp !== null && {
            acp: {
              orders: {
                converted: (token) =>
                  platform.commandStore.read((tx) =>
                    repos.order.findLastConvertedByCartToken(tx, token),
                  ),
                pending: (token) =>
                  platform.commandStore.read((tx) => repos.order.findPendingByCartToken(tx, token)),
              },
              sessions: platform.documentStore,
              checkout: services.checkout,
              idempotent: (command, { key, hash }, run) =>
                runAsActor(ACP_ACTOR, () =>
                  idempotentCommand(
                    platform.commandStore,
                    command,
                    { actor: ACP_ACTOR, key, hash, provider: true },
                    run,
                  ),
                ),
              payments: {
                providerName: adapters.payments.providerName,
                environment: acp.environment,
              },
              config: acp,
              logger: logger.child({ surface: 'acp' }),
            },
          }),
        })
      },
      get mcp() {
        return mcp
      },
      get assistantTools() {
        return assistantTools
      },
      get agents() {
        return agents
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
