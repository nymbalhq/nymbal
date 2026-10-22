import {
  ConfigError,
  type AiAdapter,
  type CommerceSlot,
  type CommerceSlotAdapters,
  type Logger,
  type PaymentsAdapter,
  type SecurityAdapter,
} from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import type { RawClients } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import { createMiddlewareSecurityAdapter } from './security/middleware-adapter.js'
import { createNativeStubPaymentsAdapter } from './payments/native-stub.js'
import { createNativeEmailAdapter } from './email/native-email-adapter.js'
import { createNativeSearchAdapter } from './search/native-adapter.js'
import { createNativeReviewsAdapter } from './reviews/native-adapter.js'
import { createNativeAnalyticsAdapter } from './analytics/native-adapter.js'
import { createNativeShippingAdapter } from './shipping/native-adapter.js'
import { createNativeTaxAdapter } from './tax/native-adapter.js'
import { declaredSettings, importProviderPackage } from './loader.js'
import { createNotConfiguredAdapter } from './not-configured.js'
import { fillFromSettings, missingSecrets, type SettingValue } from '../settings/resolve.js'

/** One adapter per commerce slot. */
export type CommerceAdapters = CommerceSlotAdapters

/** Adapters a project hands `createApp`, each for a slot whose provider is `custom`. */
export type InjectedAdapters = Partial<CommerceAdapters>

export const COMMERCE_SLOTS = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const satisfies readonly CommerceSlot[]

export interface AdapterRegistry extends Omit<CommerceAdapters, 'ai'> {
  security: SecurityAdapter
  /** `null` when the config's ai provider is `none`. */
  ai: AiAdapter | null
}

type SlotAdapter<S extends CommerceSlot> = AdapterRegistry[S]

export interface BuildAdaptersDeps {
  config: NymbalConfig
  logger: Logger
  /** The command store's own connection: the native search index lives in its database. */
  sql: RawClients
  repos: Repositories
  injected?: InjectedAdapters
  /** The payments adapter `createApp` resolved before it opened the store. */
  payments: PaymentsAdapter
  /** The values Settings hold for the slots' declared fields, decrypted: what fills what the config leaves unset. */
  settings?: readonly SettingValue[]
}

/**
 * A `custom` slot takes the adapter the project injected, and an injected adapter needs a `custom` slot: anything
 * else is a configuration mistake, refused before anything is built.
 */
export function checkInjectedAdapters(config: NymbalConfig, injected: InjectedAdapters = {}): void {
  for (const slot of COMMERCE_SLOTS) checkInjectedSlot(config, slot, injected)
}

/** `checkInjectedAdapters` for one slot. */
export function checkInjectedSlot(
  config: NymbalConfig,
  slot: CommerceSlot,
  injected: InjectedAdapters = {},
): void {
  const provider = config.commerce[slot].provider
  const given = injected[slot] !== undefined
  if (provider === 'custom' && !given) {
    throw new ConfigError(
      `commerce.${slot}.provider is 'custom' but createApp was given no ${slot} adapter ` +
        `(createApp(config, { adapters: { ${slot} } })); nymbal dev takes it from the \`adapters\` export of ` +
        'nymbal.config.ts.',
      { code: 'adapter.custom_mismatch', context: { slot } },
    )
  }
  if (provider !== 'custom' && given) {
    throw new ConfigError(
      `createApp was given a ${slot} adapter, but commerce.${slot}.provider is '${provider}'; ` +
        `set it to 'custom' to use the injected adapter.`,
      { code: 'adapter.custom_mismatch', context: { slot, provider } },
    )
  }
}

type BuiltIns<S extends CommerceSlot> = Readonly<Record<string, () => SlotAdapter<S>>>

/**
 * The slot's adapter, from the injected ones (`custom`), an adapter package, or the kernel's own, initialized with the
 * slot's config block. A package's declared settings fill the block where it is unset (config, then env, then
 * `settings`); a declared secret set nowhere gives the not-configured adapter instead of building the package. A
 * provider none of them has is refused, never replaced by a stand-in.
 */
async function resolveSlot<S extends CommerceSlot>(
  slot: S,
  config: NymbalConfig,
  logger: Logger,
  injected: InjectedAdapters,
  builtIns: BuiltIns<S>,
  settings: readonly SettingValue[],
): Promise<SlotAdapter<S>> {
  const block = config.commerce[slot]
  let blockConfig = block.config ?? {}
  let adapter: SlotAdapter<S> | undefined
  if (block.provider === 'custom') {
    adapter = injected[slot] as SlotAdapter<S> | undefined
  } else {
    const mod = await importProviderPackage(slot, block.provider, process.env)
    if (mod !== undefined) {
      const declared = declaredSettings(mod)
      blockConfig = fillFromSettings(slot, blockConfig, declared, settings, process.env)
      const missing = missingSecrets(blockConfig, declared)
      adapter = (
        missing.length > 0
          ? createNotConfiguredAdapter(slot, block.provider, missing)
          : await mod.createAdapter({
              slot,
              config: blockConfig,
              logger: logger.child({ adapter: slot }),
              env: process.env,
            })
      ) as SlotAdapter<S>
    } else if (Object.hasOwn(builtIns, block.provider)) {
      adapter = builtIns[block.provider]!()
    }
  }
  if (adapter === undefined) {
    throw new ConfigError(`commerce.${slot}.provider '${block.provider}' has no adapter`, {
      context: { slot, provider: block.provider },
    })
  }
  await adapter?.initialize(blockConfig)
  return adapter
}

/** The payments adapter alone: `createApp` reads it before it opens the store. */
export function resolvePaymentsAdapter(
  config: NymbalConfig,
  logger: Logger,
  injected: InjectedAdapters = {},
  settings: readonly SettingValue[] = [],
): Promise<PaymentsAdapter> {
  return resolveSlot(
    'payments',
    config,
    logger,
    injected,
    {
      native: () =>
        createNativeStubPaymentsAdapter({ logger: logger.child({ adapter: 'payments' }) }),
    },
    settings,
  )
}

/** Builds and initializes one slot's adapter, as `buildAdapters` does; payments is `resolvePaymentsAdapter`. */
export type SlotBuilders = {
  [S in Exclude<CommerceSlot, 'payments'>]: () => Promise<SlotAdapter<S>>
}

/** Each commerce slot's builder but payments', for a caller that builds the slots one at a time. */
export function slotBuilders(deps: Omit<BuildAdaptersDeps, 'payments'>): SlotBuilders {
  const { config, logger, sql, repos } = deps
  const injected = deps.injected ?? {}
  const settings = deps.settings ?? []
  const slot = <S extends CommerceSlot>(name: S, builtIns: BuiltIns<S>) =>
    resolveSlot(name, config, logger, injected, builtIns, settings)
  return {
    email: () =>
      slot('email', {
        native: () => createNativeEmailAdapter({ logger: logger.child({ adapter: 'email' }) }),
      }),
    search: () =>
      slot('search', {
        native: () =>
          createNativeSearchAdapter({ sql, logger: logger.child({ adapter: 'search' }) }),
      }),
    reviews: () =>
      slot('reviews', {
        native: () =>
          createNativeReviewsAdapter({ repos, logger: logger.child({ adapter: 'reviews' }) }),
      }),
    analytics: () => slot('analytics', { native: () => createNativeAnalyticsAdapter(logger) }),
    shipping: () => slot('shipping', { native: () => createNativeShippingAdapter(logger) }),
    tax: () => slot('tax', { native: () => createNativeTaxAdapter(logger) }),
    ai: () => slot('ai', { none: () => null }),
  }
}

export async function buildAdapters(deps: BuildAdaptersDeps): Promise<AdapterRegistry> {
  const { logger, payments } = deps
  const build = slotBuilders(deps)

  const email = await build.email()
  const search = await build.search()
  const reviews = await build.reviews()
  const analytics = await build.analytics()
  const shipping = await build.shipping()
  const tax = await build.tax()
  const ai = await build.ai()
  const security = createMiddlewareSecurityAdapter({
    logger: logger.child({ adapter: 'security' }),
  })

  return { security, payments, email, search, reviews, analytics, shipping, tax, ai }
}
