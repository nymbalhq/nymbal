import {
  boundedHealthCheck,
  ConfigError,
  currencyExponent,
  HEALTH_CHECK_TIMEOUT_MS,
  type HealthReport,
  type Logger,
  type PromotionEvaluation,
  type PromotionOrder,
  type PromotionSession,
  type PromotionsAdapter,
  type PromotionsCapability,
} from '@nymbalhq/types'
import { isObject, talonOneApi, unavailable, type Answered, type TalonOneApi } from './api.js'
import { readEffects } from './effects.js'

export interface TalonOnePromotionsAdapterConfig {
  /** Where the Application's deployment is: `https://<deployment>.talon.one`. Read from the config block only. */
  baseUrl: string
  /** An Integration API key of the Application. */
  apiKey: string
  /** The Application's currency (ISO 4217): Talon.One reads every price in it. */
  currency: string
  /** How long a call to Talon.One may take: 2500 ms unless given, under the kernel's 3 s bound. */
  timeoutMs?: number
}

export const DEFAULT_TIMEOUT_MS = 2500

const CAPABILITIES: readonly PromotionsCapability[] = ['codes', 'automatic', 'line']

interface Settled {
  api: TalonOneApi
  currency: string
  exponent: number
}

const LOOPBACK = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/

const refuse = (message: string): ConfigError =>
  new ConfigError(`commerce.promotions.config: ${message}`, { context: { provider: 'talon-one' } })

/** The block checked: the key goes to `baseUrl` alone, so it must be TLS, or plain HTTP to this machine. */
function settle(config: Partial<TalonOnePromotionsAdapterConfig>): Settled {
  let url: URL
  try {
    url = new URL(String(config.baseUrl))
  } catch {
    throw refuse('baseUrl is not a URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) {
    throw refuse('baseUrl must be https: (plain http: only to a loopback host)')
  }
  if (typeof config.currency !== 'string' || config.currency === '') {
    throw refuse('currency is required: the Application’s currency, such as GBP')
  }
  if (typeof config.apiKey !== 'string' || config.apiKey === '') {
    throw refuse('apiKey is required')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  return {
    api: talonOneApi({ base, apiKey: config.apiKey, timeoutMs }),
    currency: config.currency.toUpperCase(),
    exponent: currencyExponent(config.currency),
  }
}

/** The effects of a 200 with JSON and an `effects` array; anything else rejects, naming the step and the status. */
function effectsOf(step: string, answered: Answered): unknown[] {
  const { status, body } = answered
  if (status !== 200) {
    throw unavailable(`Talon.One answered ${step} with ${status}`, { step, status })
  }
  if (!isObject(body)) {
    throw unavailable(`Talon.One answered ${step} without JSON`, { step, status })
  }
  const effects = body['effects']
  if (!Array.isArray(effects)) {
    throw unavailable(`Talon.One answered ${step} with no effects`, { step, status })
  }
  return effects
}

/** A 4xx saying the session is already in `state`: a retry whose first call landed. */
function alreadyIn(answered: Answered, state: string): boolean {
  const message = isObject(answered.body) ? answered.body['message'] : undefined
  return (
    answered.status >= 400 &&
    answered.status < 500 &&
    typeof message === 'string' &&
    new RegExp(`\\bis (already )?${state}\\b`, 'i').test(message)
  )
}

export function createTalonOnePromotionsAdapter(deps: {
  logger: Logger
  config: TalonOnePromotionsAdapterConfig
}): PromotionsAdapter {
  const { logger } = deps
  let config: Partial<TalonOnePromotionsAdapterConfig> = deps.config
  let settled: Settled | undefined
  const ready = (): Settled => (settled ??= settle(config))

  async function evaluate(
    session: PromotionSession,
    opts: { dry?: boolean; orderId?: string } = {},
  ): Promise<PromotionEvaluation> {
    const s = ready()
    if (session.currency.toUpperCase() !== s.currency) {
      throw unavailable(
        `Talon.One evaluate refused: the session is in ${session.currency}, the Application in ${s.currency}`,
        { step: 'evaluate' },
      )
    }
    const dry = opts.dry === true || opts.orderId === undefined
    const body = {
      customerSession: {
        ...(typeof session.customerId === 'string' && { profileId: session.customerId }),
        state: 'open',
        couponCodes: [...session.codes],
        cartItems: session.lines.map((l) => ({
          sku: l.sku === '' ? l.variantId : l.sku,
          quantity: l.qty,
          price: l.unitMinor / 10 ** s.exponent,
        })),
      },
      responseContent: ['coupons'],
    }
    const id = dry ? session.id : opts.orderId!
    const answered = await s.api.putSession('evaluate', id, body, { dry })
    const effects = effectsOf('evaluate', answered)
    return {
      effects: readEffects(
        effects,
        (answered.body as { coupons?: unknown }).coupons,
        session,
        s.exponent,
      ),
      // The order keeps a promotion record from this, so its session is closed or cancelled even when nothing applied.
      ...(!dry && { evaluationId: id }),
    }
  }

  /** Moves the order's session to `state` once: a retry replays the first answer under the same key. */
  async function settleSession(orderId: string, state: 'closed' | 'cancelled'): Promise<unknown[]> {
    const step = state === 'closed' ? 'close' : 'cancel'
    const answered = await ready().api.putSession(
      step,
      orderId,
      { customerSession: { state } },
      { idempotencyKey: `${orderId}:${state}` },
    )
    if (alreadyIn(answered, state)) return []
    return effectsOf(step, answered)
  }

  return {
    kind: 'promotions',
    providerName: 'talon-one',
    capabilities: () => CAPABILITIES,
    producesEvents: [],
    consumesEvents: [],
    async initialize(rawConfig) {
      config = { ...config, ...(rawConfig as Partial<TalonOnePromotionsAdapterConfig>) }
      settled = settle(config)
    },
    healthCheck(): Promise<HealthReport> {
      return boundedHealthCheck(
        async (signal) => {
          const s = ready()
          const answered = await s.api.putSession(
            'health check',
            'nymbal-health',
            { customerSession: { state: 'open', couponCodes: [], cartItems: [] } },
            { dry: true, signal },
          )
          if (answered.status === 200) return { status: 'healthy' }
          return {
            status: 'down',
            detail: `Talon.One answered the health check with ${answered.status}`,
          }
        },
        {
          redact: typeof config.apiKey === 'string' ? [config.apiKey] : [],
          timeoutMs: Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, HEALTH_CHECK_TIMEOUT_MS),
        },
      )
    },
    evaluate,
    async close(_sessionId: string, order: PromotionOrder) {
      const effects = await settleSession(order.orderId, 'closed')
      for (const effect of effects) {
        if (!isObject(effect) || effect['effectType'] !== 'rejectCoupon') continue
        const props = isObject(effect['props']) ? effect['props'] : {}
        logger.error(
          { orderId: order.orderId, code: props['value'], reason: props['rejectionReason'] },
          'Talon.One refused a code at close: the order keeps its discount, but the code’s use was not counted',
        )
      }
    },
    async cancel(_sessionId: string, orderId: string) {
      await settleSession(orderId, 'cancelled')
    },
  }
}
