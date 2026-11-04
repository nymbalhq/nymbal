import { BUILT_IN, KNOWN_PROVIDERS, type CommerceSlot, type NymbalConfig } from '@nymbalhq/config'

export interface PreviewConfigOptions {
  /** The preview's own directory; the store, its media and its import state live there. */
  dir: string
  apiPort: number
  /** Where the preview's storefront runs; null with no storefront. */
  storefrontOrigin: string | null
  /** Keep the project's ai provider, so the import enriches products as `--ai` asks. */
  ai: boolean
}

/**
 * The config a preview runs its throwaway store on: the project's store and template, with every service that could
 * mail a customer, bill a key, index a catalogue, write a bucket or share a database swapped for the kernel's own.
 * The input is not changed.
 */
export function previewConfig(config: NymbalConfig, options: PreviewConfigOptions): NymbalConfig {
  const slots = Object.fromEntries(
    (Object.keys(KNOWN_PROVIDERS) as CommerceSlot[]).map((slot) => [
      slot,
      slot === 'ai' && options.ai ? config.commerce.ai : { provider: BUILT_IN[slot][0] },
    ]),
  )
  const commerce = { ...config.commerce, ...slots } as NymbalConfig['commerce']

  const {
    package: _package,
    config: _config,
    cloudflare: _cloudflare,
    ...security
  } = config.security
  const { archive: _archive, ...events } = config.events
  const origin = options.storefrontOrigin
  const allowedOrigins =
    origin === null ? [] : [origin, origin.replace('//localhost:', '//127.0.0.1:')]

  return structuredClone({
    ...config,
    commerce,
    security: { ...security, adapter: 'middleware' },
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
      media: { provider: 'local-fs' },
    },
    events,
    http: {
      ...config.http,
      host: '127.0.0.1',
      port: options.apiPort,
      cors: { ...config.http.cors, allowedOrigins: [...new Set(allowedOrigins)] },
    },
  }) as NymbalConfig
}
