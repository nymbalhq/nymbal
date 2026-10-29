import { AdapterError, type Logger, type ShippingAdapter } from '@nymbalhq/types'
import { EASYPOST_TRACKING, receiveEasyPostWebhook } from './webhook.js'

export interface EasyPostShippingAdapterConfig {
  /** The webhook's secret, set in EasyPost's dashboard. Without it every webhook post is refused, and health says so. */
  webhookSecret?: string
}

const NO_SECRET = 'webhook secret not set: every EasyPost webhook post is refused'

/** Rates, labels and tracking lookups go through EasyPost's API, which this adapter does not call. */
function unsupported(method: string): Promise<never> {
  return Promise.reject(
    new AdapterError(
      'shipping.unsupported',
      `EasyPost serves tracker webhooks only: ${method} is not supported`,
      { context: { provider: 'easypost', method } },
    ),
  )
}

export function createEasyPostShippingAdapter(deps: {
  logger: Logger
  config?: EasyPostShippingAdapterConfig
}): ShippingAdapter {
  let cfg: EasyPostShippingAdapterConfig = deps.config ?? {}
  const secret = () =>
    typeof cfg.webhookSecret === 'string' && cfg.webhookSecret !== ''
      ? cfg.webhookSecret
      : undefined

  return {
    kind: 'shipping',
    providerName: 'easypost',
    capabilities: () => ['tracking-webhook'],
    producesEvents: [EASYPOST_TRACKING],
    consumesEvents: [],
    async initialize(rawConfig) {
      cfg = { ...cfg, ...(rawConfig as EasyPostShippingAdapterConfig) }
    },
    healthCheck: async () =>
      secret() === undefined ? { status: 'degraded', detail: NO_SECRET } : { status: 'healthy' },
    rate: () => unsupported('rate'),
    createLabel: () => unsupported('createLabel'),
    track: () => unsupported('track'),
    receiveWebhook: async (rawBody, headers) => receiveEasyPostWebhook(secret(), rawBody, headers),
  }
}
