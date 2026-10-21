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
import { loadProviderAdapter } from './loader.js'

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
}

/**
 * A `custom` slot takes the adapter the project injected, and an injected adapter needs a `custom` slot: anything
 * else is a configuration mistake, refused before anything is built.
 */
export function checkInjectedAdapters(config: NymbalConfig, injected: InjectedAdapters = {}): void {
  for (const slot of COMMERCE_SLOTS) {
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
}

type BuiltIns<S extends CommerceSlot> = Readonly<Record<string, () => SlotAdapter<S>>>

/**
 * The slot's adapter, from the injected ones (`custom`), an adapter package, or the kernel's own, initialized with the
 * slot's config block. A provider none of them has is refused, never replaced by a stand-in.
 */
async function resolveSlot<S extends CommerceSlot>(
  slot: S,
  config: NymbalConfig,
  logger: Logger,
  injected: InjectedAdapters,
  builtIns: BuiltIns<S>,
): Promise<SlotAdapter<S>> {
  const block = config.commerce[slot]
  const blockConfig = block.config ?? {}
  let adapter: SlotAdapter<S> | undefined
  if (block.provider === 'custom') {
    adapter = injected[slot] as SlotAdapter<S> | undefined
  } else {
    adapter = (await loadProviderAdapter(slot, block.provider, {
      config: blockConfig,
      logger: logger.child({ adapter: slot }),
      env: process.env,
    })) as SlotAdapter<S> | undefined
    if (adapter === undefined && Object.hasOwn(builtIns, block.provider)) {
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
): Promise<PaymentsAdapter> {
  return resolveSlot('payments', config, logger, injected, {
    native: () =>
      createNativeStubPaymentsAdapter({ logger: logger.child({ adapter: 'payments' }) }),
  })
}

export async function buildAdapters(deps: BuildAdaptersDeps): Promise<AdapterRegistry> {
  const { config, logger, sql, repos, payments } = deps
  const injected = deps.injected ?? {}
  const slot = <S extends CommerceSlot>(name: S, builtIns: BuiltIns<S>) =>
    resolveSlot(name, config, logger, injected, builtIns)

  const email = await slot('email', {
    native: () => createNativeEmailAdapter({ logger: logger.child({ adapter: 'email' }) }),
  })
  const search = await slot('search', {
    native: () => createNativeSearchAdapter({ sql, logger: logger.child({ adapter: 'search' }) }),
  })
  const reviews = await slot('reviews', {
    native: () =>
      createNativeReviewsAdapter({ repos, logger: logger.child({ adapter: 'reviews' }) }),
  })
  const analytics = await slot('analytics', { native: () => createNativeAnalyticsAdapter(logger) })
  const shipping = await slot('shipping', { native: () => createNativeShippingAdapter(logger) })
  const tax = await slot('tax', { native: () => createNativeTaxAdapter(logger) })
  const ai = await slot('ai', { none: () => null })
  const security = createMiddlewareSecurityAdapter({
    logger: logger.child({ adapter: 'security' }),
  })

  return { security, payments, email, search, reviews, analytics, shipping, tax, ai }
}
