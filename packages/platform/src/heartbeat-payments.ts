import type { NymbalConfig } from '@nymbalhq/config'
import { ConfigError, type Logger, type PaymentsAdapter } from '@nymbalhq/types'
import { isNotConfigured } from './adapters/not-configured.js'
import { resolvePaymentsAdapter, type InjectedAdapters } from './adapters/registry.js'
import { loadBootSettings } from './settings/load.js'

export interface ResolveStorePaymentsOptions {
  /** The project's `adapters` export: a `custom` payments provider resolves as it does in the store. */
  adapters?: InjectedAdapters
  sqlitePath?: string
  postgresUrl?: string
  env: NodeJS.ProcessEnv
  logger: Logger
}

/**
 * The store's payments adapter outside the store, as `createApp` builds it: the keys entered in the admin are read from
 * the command store first, then the adapter is resolved from the config and the project's adapters. A secret set
 * nowhere refuses with a `ConfigError` naming it: the store boots on a placeholder so the admin can take the key, but
 * outside the store the placeholder could only refuse every call.
 */
export async function resolveStorePayments(
  config: NymbalConfig,
  options: ResolveStorePaymentsOptions,
): Promise<PaymentsAdapter> {
  const settings = await loadBootSettings(config, {
    storage: {
      ...(options.sqlitePath !== undefined && { sqlitePath: options.sqlitePath }),
      ...(options.postgresUrl !== undefined && { postgresUrl: options.postgresUrl }),
    },
    env: options.env,
    logger: options.logger,
  })
  const payments = await resolvePaymentsAdapter(
    config,
    options.logger,
    options.adapters,
    settings.values,
  )
  if (isNotConfigured(payments)) {
    throw new ConfigError((await payments.healthCheck()).detail ?? 'payments is not configured', {
      code: 'config.not_configured',
      context: { slot: 'payments', provider: payments.providerName },
    })
  }
  return payments
}
