import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type SearchAdapter,
} from '@nymbalhq/types'
import { createAlgoliaSearchAdapter } from './adapter.js'
import type { AlgoliaConnection } from './client.js'

/** What this package serves: the kernel refuses it on any other slot or provider. */
export const slot = 'search'
export const provider = 'algolia'

export {
  createAlgoliaSearchAdapter,
  DEFAULT_INDEX,
  encodeSearchCursor,
  INDEX_SETTINGS,
  type AlgoliaSearchAdapterDeps,
} from './adapter.js'
export { REQUEST_TIMEOUT_MS, type AlgoliaConnection } from './client.js'
export { MAX_TERM, QUERY_LIMIT_BYTES, RECORD_LIMIT_BYTES } from './records.js'

/** The fields the config, the environment or the admin's Settings may fill; with no API key the slot is down. */
export const settings: AdapterSetting[] = [
  { path: 'appId', label: 'Algolia application ID', secret: false, env: 'ALGOLIA_APP_ID' },
  {
    path: 'apiKey',
    label: 'Algolia API key that may write the index',
    secret: true,
    env: 'ALGOLIA_API_KEY',
  },
  {
    path: 'indexName',
    label: 'Algolia index name (default products)',
    secret: false,
    env: 'ALGOLIA_INDEX',
    optional: true,
  },
]

/** The kernel's entry: `search: { provider: 'algolia', config: AlgoliaConnection }`. */
export function createAdapter(ctx: AdapterContext): SearchAdapter {
  if (ctx.slot !== 'search') {
    throw new ConfigError(`@nymbalhq/search-algolia serves search, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  const connection = ctx.config as unknown as AlgoliaConnection
  if (typeof connection.appId !== 'string' || connection.appId === '') {
    throw new ConfigError(
      'commerce.search.config.appId is not set: set ALGOLIA_APP_ID to your Algolia application ID',
      { code: 'adapter.algolia_app_id', context: { slot: ctx.slot } },
    )
  }
  // fetch refuses such a header, and its refusal quotes the value.
  if (typeof connection.apiKey === 'string' && /[\0\r\n]|[^\0-\xff]/.test(connection.apiKey)) {
    throw new ConfigError(
      'commerce.search.config.apiKey is not a valid header value (it holds a line break, a NUL or a character past U+00FF): check ALGOLIA_API_KEY',
      { code: 'adapter.algolia_api_key', context: { slot: ctx.slot } },
    )
  }
  return createAlgoliaSearchAdapter({ connection, logger: ctx.logger })
}
