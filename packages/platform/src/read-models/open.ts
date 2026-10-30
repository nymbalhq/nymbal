import type { NymbalConfig } from '@nymbalhq/config'
import type { Logger } from '@nymbalhq/types'
import { createCommandStore, rawClients } from '../db/command-store.js'
import { slotBuilders, type InjectedAdapters } from '../adapters/registry.js'
import { buildDocumentStore } from '../platform.js'
import { buildRepositories } from '../repositories/index.js'
import { loadBootSettings } from '../settings/load.js'
import type { RebuildDeps } from './model.js'

export interface OpenReadModelsOptions {
  logger: Logger
  /** The project's own adapters, for a `custom` search slot. */
  adapters?: InjectedAdapters
  sqlitePath?: string
  postgresUrl?: string
  env?: NodeJS.ProcessEnv
}

/**
 * What a rebuild outside the server needs, built as `createApp` builds it: the command store (writable), the document
 * store and the search adapter. No bus, relay, sweeper or other slot. `close()` closes what it opened.
 */
export async function openReadModels(
  config: NymbalConfig,
  options: OpenReadModelsOptions,
): Promise<{ deps: RebuildDeps; close(): Promise<void> }> {
  const { logger } = options
  const env = options.env ?? process.env
  const storage = {
    ...(options.sqlitePath !== undefined && { sqlitePath: options.sqlitePath }),
    ...(options.postgresUrl !== undefined && { postgresUrl: options.postgresUrl }),
  }
  const settings = await loadBootSettings(config, { storage, env, logger })
  const store = createCommandStore(config, storage)
  const closers: Array<() => Promise<void>> = [() => store.close()]
  const close = async () => {
    for (const c of closers.splice(0).reverse()) await c()
  }
  try {
    const documentStore = await buildDocumentStore(config, { ...storage, logger, env }, logger, env)
    closers.push(() => documentStore.close())
    if (config.infrastructure.documentStore.provider === 'postgres-jsonb')
      await documentStore.initialize?.()
    const repos = buildRepositories(store, documentStore)
    const search = await slotBuilders({
      config,
      logger: logger.child({ layer: 'adapter' }),
      sql: rawClients(store),
      repos,
      settings: settings.values,
      ...(options.adapters !== undefined && { injected: options.adapters }),
    }).search()
    return { deps: { config, store, repos, documentStore, search, logger }, close }
  } catch (error) {
    await close()
    throw error
  }
}
