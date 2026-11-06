import {
  AdapterError,
  boundedHealthCheck,
  HEALTH_CHECK_TIMEOUT_MS,
  type Address,
  type HealthReport,
  type Logger,
  type Parcel,
  type ShippingAdapter,
  type ShippingCapability,
  type ShippingLabel,
  type ShippingLabelParams,
  type ShippingRate,
  type ShippingRateParams,
  type StartTrackingParams,
  type StartTrackingResult,
} from '@nymbalhq/types'
import {
  DEFAULT_API_BASE,
  DEFAULT_TIMEOUT_MS,
  easyPostApi,
  isObject,
  type EasyPostApi,
  type Json,
} from './api.js'
import { EASYPOST_TRACKING, receiveEasyPostWebhook } from './webhook.js'

export interface EasyPostShippingAdapterConfig {
  /** The webhook's secret, set in EasyPost's dashboard. Without it every webhook post is refused, and health says so. */
  webhookSecret?: string
  /** EasyPost's API key (a Test key in test mode). With it the adapter rates, buys labels and registers tracking. */
  apiKey?: string
  /** Where EasyPost's API is: `https://api.easypost.com/v2/` unless given (a proxy, or a test's fake). */
  apiBase?: string
  /** How long a call to EasyPost may take before it counts as an outage: 10 s unless given. */
  timeoutMs?: number
}

const NO_SECRET = 'webhook secret not set: every EasyPost webhook post is refused'
/** Grams per ounce × 10^9, and tenths of a millimetre per inch: integers, so the rounding below is exact. */
const GRAMS_PER_OUNCE_NANO = 28_349_523_125
const MM_PER_INCH_TENTHS = 254

/** The carriers named to EasyPost, by the merchant's text with case and spaces ignored; any other is detected. */
const CARRIERS: ReadonlyMap<string, string> = new Map([
  ['usps', 'USPS'],
  ['ups', 'UPS'],
  ['fedex', 'FedEx'],
  ['dhl', 'DHLExpress'],
  ['dhlexpress', 'DHLExpress'],
  ['royalmail', 'RoyalMail'],
])

const refused = (message: string): AdapterError =>
  new AdapterError('shipping.refused', message, { context: { provider: 'easypost' } })

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

/** `numerator / denominator` tenths, rounded up: a parcel is never declared lighter or smaller than it is. */
const tenthsUp = (numerator: number, denominator: number): number =>
  Math.ceil(numerator / denominator) / 10

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** The parcel in ounces and inches; one or two dimensions, or a weight or size that is not positive, is refused. */
function easypostParcel(parcel: Parcel): Json {
  const given = parcel as Partial<Record<'weightGrams' | 'lengthMm' | 'widthMm' | 'heightMm', unknown>>
  const sizes = [given.lengthMm, given.widthMm, given.heightMm]
  const present = sizes.filter((v) => v !== undefined).length
  if (!positive(given.weightGrams)) throw refused('the parcel needs a positive weightGrams')
  if (present !== 0 && present !== 3) {
    throw refused('the parcel needs all three of lengthMm, widthMm and heightMm, or none')
  }
  if (!sizes.slice(0, present).every(positive)) {
    throw refused('each of the parcel’s lengthMm, widthMm and heightMm must be positive')
  }
  const weight = tenthsUp(given.weightGrams * 1e10, GRAMS_PER_OUNCE_NANO)
  if (present === 0) return { weight }
  const [length, width, height] = (sizes as number[]).map((mm) =>
    tenthsUp(mm * 100, MM_PER_INCH_TENTHS),
  )
  return { weight, length, width, height }
}

function easypostAddress(a: Address): Json {
  const fields: Record<string, string | undefined> = {
    name: `${a.firstName} ${a.lastName}`,
    company: a.company,
    street1: a.addressLine1,
    street2: a.addressLine2,
    city: a.city,
    state: a.region,
    zip: a.postalCode,
    country: a.country,
    phone: a.phone,
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
}

/**
 * EasyPost's decimal amount in the currency's minor units, exactly. Digits past the currency's are taken only as
 * zeros: rounding would quote or charge another amount than EasyPost's.
 */
function minorUnits(amount: unknown, currency: unknown): number {
  const text = String(amount)
  let digits: number
  try {
    digits =
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: String(currency),
      }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    throw refused(`EasyPost answered ${text} in an unknown currency ${String(currency)}`)
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (match === null) throw refused(`EasyPost answered an amount that is not a decimal: ${text}`)
  const fraction = match[2] ?? ''
  if (/[1-9]/.test(fraction.slice(digits))) {
    throw refused(
      `EasyPost answered ${text} ${String(currency)}, finer than the currency's ${digits} digits`,
    )
  }
  const minor = Number(match[1]! + fraction.slice(0, digits).padEnd(digits, '0'))
  if (!Number.isSafeInteger(minor)) throw refused(`EasyPost answered an amount too large: ${text}`)
  return minor
}

function rateOf(shipmentId: string, rate: Json): ShippingRate {
  const days = rate['delivery_days'] ?? rate['est_delivery_days'] ?? null
  return {
    id: `${shipmentId}:${String(rate['id'])}`,
    carrier: String(rate['carrier'] ?? ''),
    service: String(rate['service'] ?? ''),
    amountMinor: minorUnits(rate['rate'], rate['currency']),
    currency: String(rate['currency']),
    estimatedDays: typeof days === 'number' ? days : null,
  }
}

/** The label a Shipment holds for `rateId`, or null when it has none or was bought with another rate. */
function labelOf(shipment: Json, rateId: string): ShippingLabel | null {
  const selected = shipment['selected_rate']
  const postage = shipment['postage_label']
  const code = shipment['tracking_code']
  if (!isObject(selected) || selected['id'] !== rateId) return null
  if (!isObject(postage) || typeof postage['label_url'] !== 'string') return null
  if (typeof code !== 'string' || code === '') return null
  return {
    labelUrl: postage['label_url'],
    trackingNumber: code,
    carrier: String(selected['carrier'] ?? ''),
    service: String(selected['service'] ?? ''),
    amountMinor: minorUnits(selected['rate'], selected['currency']),
    currency: String(selected['currency']),
  }
}

/** `<shipment_id>:<rate_id>`, as `rate` writes a rate's id. */
function splitRateId(rateId: string): [string, string] {
  const at = rateId.indexOf(':')
  if (at <= 0 || at === rateId.length - 1) throw refused(`not an EasyPost rate id: ${rateId}`)
  return [rateId.slice(0, at), rateId.slice(at + 1)]
}

async function rate(api: EasyPostApi, params: ShippingRateParams): Promise<ShippingRate[]> {
  const parcel = easypostParcel(params.parcel)
  const shipment = await api.request('POST', 'shipments', {
    shipment: {
      from_address: easypostAddress(params.from),
      to_address: easypostAddress(params.to),
      parcel,
    },
  })
  const rates = Array.isArray(shipment['rates']) ? shipment['rates'] : []
  return rates.filter(isObject).map((r) => rateOf(String(r['shipment_id'] ?? shipment['id']), r))
}

async function createLabel(api: EasyPostApi, params: ShippingLabelParams): Promise<ShippingLabel> {
  const [shipmentId, rateId] = splitRateId(params.rateId)
  const path = `shipments/${encodeURIComponent(shipmentId)}`
  let bought: Json
  try {
    bought = await api.request('POST', `${path}/buy`, { rate: { id: rateId } })
  } catch (refusal) {
    if (codeOf(refusal) !== 'adapter.shipping.refused') throw refusal
    // A retry of a buy whose answer was lost: the shipment already holds this rate's label, so it is not bought again.
    let shipment: Json
    try {
      shipment = await api.request('GET', path)
    } catch (error) {
      throw codeOf(error) === 'adapter.shipping.unavailable' ? error : refusal
    }
    const label = labelOf(shipment, rateId)
    if (label === null) throw refusal
    return label
  }
  const label = labelOf(bought, rateId)
  if (label === null) throw refused(`EasyPost bought ${shipmentId} but answered no label for it`)
  return label
}

async function startTracking(
  api: EasyPostApi,
  params: StartTrackingParams,
): Promise<StartTrackingResult> {
  const carrier =
    params.carrier === null
      ? undefined
      : CARRIERS.get(params.carrier.replace(/\s+/g, '').toLowerCase())
  try {
    // EasyPost answers a code and carrier it already tracks for this account with the original Tracker.
    await api.request('POST', 'trackers', {
      tracker: { tracking_code: params.trackingNumber, ...(carrier !== undefined && { carrier }) },
    })
    return { status: 'tracking' }
  } catch (error) {
    if (codeOf(error) !== 'adapter.shipping.refused') throw error
    return { status: 'refused', reason: (error as Error).message }
  }
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
  // Fixed at construction, as the words are: the kernel reads them once, at startup.
  const apiKey = typeof cfg.apiKey === 'string' && cfg.apiKey !== '' ? cfg.apiKey : undefined
  const timeoutMs = () => cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const api = (): EasyPostApi =>
    easyPostApi({
      apiKey: apiKey ?? '',
      apiBase: cfg.apiBase ?? DEFAULT_API_BASE,
      timeoutMs: timeoutMs(),
    })
  const words: ShippingCapability[] = apiKey === undefined ? [] : ['rates', 'labels', 'tracking']
  const answering = (): HealthReport =>
    secret() === undefined ? { status: 'degraded', detail: NO_SECRET } : { status: 'healthy' }

  function healthCheck(): Promise<HealthReport> {
    if (apiKey === undefined) return Promise.resolve(answering())
    return boundedHealthCheck(
      async (signal) => {
        const status = await api().status('trackers?page_size=1', signal)
        if (status >= 200 && status < 300) return answering()
        // A refused key is not an outage: down for ever would keep the relay from counting any failure.
        if (status === 401 || status === 403) {
          return { status: 'degraded', detail: `EasyPost refused the API key (${status})` }
        }
        return { status: 'down', detail: `EasyPost answered GET trackers with ${status}` }
      },
      {
        redact: [apiKey, Buffer.from(`${apiKey}:`, 'utf8').toString('base64')],
        timeoutMs: Math.min(timeoutMs(), HEALTH_CHECK_TIMEOUT_MS),
      },
    )
  }

  return {
    kind: 'shipping',
    providerName: 'easypost',
    capabilities: () => words,
    producesEvents: [EASYPOST_TRACKING],
    consumesEvents: [],
    async initialize(rawConfig) {
      cfg = { ...cfg, ...(rawConfig as EasyPostShippingAdapterConfig) }
    },
    healthCheck,
    ...(apiKey !== undefined && {
      rate: (params: ShippingRateParams) => rate(api(), params),
      createLabel: (params: ShippingLabelParams) => createLabel(api(), params),
      startTracking: (params: StartTrackingParams) => startTracking(api(), params),
    }),
    receiveWebhook: async (rawBody, headers) => receiveEasyPostWebhook(secret(), rawBody, headers),
  }
}
