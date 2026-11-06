import {
  AdapterError,
  boundedHealthCheck,
  HEALTH_CHECK_TIMEOUT_MS,
  type HealthReport,
  type Logger,
  type ShippingAdapter,
  type ShippingCapability,
  type StartTrackingParams,
  type StartTrackingResult,
} from '@nymbalhq/types'
import { AFTERSHIP_TRACKING, receiveAfterShipWebhook } from './webhook.js'

export interface AfterShipShippingAdapterConfig {
  /** AfterShip's API key. With it the adapter registers each shipped order's tracking number with AfterShip. */
  apiKey?: string
  /** The webhook's secret, from AfterShip's Settings > Webhooks. Without it every post is refused, and health says so. */
  webhookSecret?: string
  /** Where AfterShip's API is: `https://api.aftership.com` unless given (a proxy, or a test's fake). */
  apiBase?: string
  /** How long a call to AfterShip may take before it counts as an outage: 10 s unless given. */
  timeoutMs?: number
}

const DEFAULT_API_BASE = 'https://api.aftership.com'
const DEFAULT_TIMEOUT_MS = 10_000
const TRACKINGS = '/tracking/2026-07/trackings'
const COURIERS = '/tracking/2026-07/couriers'
/** AfterShip's meta code for a tracking it already holds: registered, as asked. */
const ALREADY_EXISTS = 4003
const NO_SECRET = 'webhook secret not set: every AfterShip webhook post is refused'

/** The slugs named to AfterShip, by the merchant's text with case and spaces ignored; any other is detected. */
const SLUGS: ReadonlyMap<string, string> = new Map([
  ['usps', 'usps'],
  ['ups', 'ups'],
  ['fedex', 'fedex'],
  ['dhl', 'dhl'],
  ['dhlexpress', 'dhl'],
  ['royalmail', 'royal-mail'],
  ['testing-courier', 'testing-courier'],
])

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const unavailable = (message: string, status?: number): AdapterError =>
  new AdapterError('shipping.unavailable', message, {
    context: { provider: 'aftership', ...(status !== undefined && { status }) },
  })

/** Why a request got no answer, without anything from the request itself. */
function reasonOf(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'no answer in time'
  }
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  return typeof cause?.code === 'string' ? cause.code : 'unreachable'
}

function metaOf(body: unknown): { code?: unknown; message?: unknown } {
  const meta = isObject(body) ? body['meta'] : undefined
  return isObject(meta) ? meta : {}
}

export function createAfterShipShippingAdapter(deps: {
  logger: Logger
  config?: AfterShipShippingAdapterConfig
}): ShippingAdapter {
  let cfg: AfterShipShippingAdapterConfig = deps.config ?? {}
  const secret = () =>
    typeof cfg.webhookSecret === 'string' && cfg.webhookSecret !== ''
      ? cfg.webhookSecret
      : undefined
  // Fixed at construction, as the words are: the kernel reads them once, at startup.
  const apiKey = typeof cfg.apiKey === 'string' && cfg.apiKey !== '' ? cfg.apiKey : undefined
  const timeoutMs = () => cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const urlOf = (path: string) => `${(cfg.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')}${path}`
  const words: ShippingCapability[] = apiKey === undefined ? [] : ['tracking']
  const answering = (): HealthReport =>
    secret() === undefined ? { status: 'degraded', detail: NO_SECRET } : { status: 'healthy' }

  async function startTracking(params: StartTrackingParams): Promise<StartTrackingResult> {
    const slug =
      params.carrier === null
        ? undefined
        : SLUGS.get(params.carrier.replace(/\s+/g, '').toLowerCase())
    let status: number
    let body: unknown = null
    try {
      const res = await fetch(urlOf(TRACKINGS), {
        method: 'POST',
        headers: {
          'as-api-key': apiKey ?? '',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          tracking_number: params.trackingNumber,
          ...(slug !== undefined && { slug }),
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      })
      status = res.status
      const text = await res.text()
      try {
        body = text === '' ? null : (JSON.parse(text) as unknown)
      } catch {
        body = null
      }
    } catch (error) {
      throw unavailable(`AfterShip did not answer POST ${TRACKINGS}: ${reasonOf(error)}`)
    }
    const meta = metaOf(body)
    if ((status >= 200 && status < 300) || meta.code === ALREADY_EXISTS) {
      return { status: 'tracking' }
    }
    if (status === 429 || status >= 500) {
      throw unavailable(`AfterShip answered POST ${TRACKINGS} with ${status}`, status)
    }
    const message = typeof meta.message === 'string' && meta.message !== '' ? meta.message : null
    return {
      status: 'refused',
      reason: `AfterShip refused the tracking (${status}${typeof meta.code === 'number' ? `, ${meta.code}` : ''}): ${message ?? 'no message'}`,
    }
  }

  function healthCheck(): Promise<HealthReport> {
    if (apiKey === undefined) return Promise.resolve(answering())
    return boundedHealthCheck(
      async (signal) => {
        const res = await fetch(urlOf(COURIERS), {
          headers: { 'as-api-key': apiKey, accept: 'application/json' },
          signal,
        })
        await res.body?.cancel()
        if (res.ok) return answering()
        // A refused key is not an outage: down for ever would keep the relay from counting any failure.
        if (res.status === 401 || res.status === 403) {
          return { status: 'degraded', detail: `AfterShip refused the API key (${res.status})` }
        }
        return { status: 'down', detail: `AfterShip answered GET couriers with ${res.status}` }
      },
      { redact: [apiKey], timeoutMs: Math.min(timeoutMs(), HEALTH_CHECK_TIMEOUT_MS) },
    )
  }

  return {
    kind: 'shipping',
    providerName: 'aftership',
    capabilities: () => words,
    producesEvents: [AFTERSHIP_TRACKING],
    consumesEvents: [],
    async initialize(rawConfig) {
      cfg = { ...cfg, ...(rawConfig as AfterShipShippingAdapterConfig) }
    },
    healthCheck,
    ...(apiKey !== undefined && { startTracking }),
    receiveWebhook: async (rawBody, headers) =>
      receiveAfterShipWebhook(secret(), rawBody, headers),
  }
}
