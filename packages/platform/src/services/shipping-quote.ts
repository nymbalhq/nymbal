import {
  CheckoutError,
  type Address,
  type Logger,
  type Parcel,
  type ShippingAdapter,
  type ShippingOption,
  type ShippingRate as CarrierRate,
} from '@nymbalhq/types'

/** How long a carrier may take to rate a parcel before it counts as down. */
export const SHIPPING_BOUND_MS = 5000

/** A row of `commerce.shipping.rates`. */
export interface ShippingRate {
  id: string
  name: string
  countries?: readonly string[] | undefined
  amountMinor: number
  freeOverMinor?: number | undefined
  estimatedDays?: number | undefined
}

/** What a store with no table offers every address: one free option. */
export const STANDARD_OPTION: ShippingOption = {
  id: 'standard',
  name: 'Standard',
  amountMinor: 0,
  estimatedDays: null,
}

/**
 * The options the table offers an address, in the table's order: the rows naming its country, else the rows naming
 * none, else none (the store does not ship there). Each is free when the goods after discount reach its threshold.
 */
export function shippingOptions(
  rates: readonly ShippingRate[],
  shipTo: Address,
  goodsMinor: number,
): ShippingOption[] {
  if (rates.length === 0) return [{ ...STANDARD_OPTION }]
  const country = shipTo.country.trim().toUpperCase()
  const naming = rates.filter((row) => row.countries?.includes(country) === true)
  const rows = naming.length > 0 ? naming : rates.filter((row) => row.countries === undefined)
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    amountMinor:
      row.freeOverMinor !== undefined && row.freeOverMinor <= goodsMinor ? 0 : row.amountMinor,
    estimatedDays: row.estimatedDays ?? null,
  }))
}

/**
 * The cart as one parcel: each unit at its variant's weight (none: the store's default; below 0: 0), rounded up to a
 * whole gram and at least 1, since a carrier refuses a weightless parcel. No dimensions: the store measures none.
 */
export function parcelOf(
  lines: readonly { weightGrams: number | null; qty: number }[],
  defaultWeightGrams: number,
): Parcel {
  const grams = lines.reduce(
    (sum, line) => sum + Math.max(0, line.weightGrams ?? defaultWeightGrams) * line.qty,
    0,
  )
  return { weightGrams: Math.max(1, Math.ceil(grams)) }
}

const idPart = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    // A run is one `_` by now, so each end holds at most one.
    .replace(/^_|_$/g, '')

/**
 * A carrier option's id, from its carrier and service alone, so it is the same on every rating call while the rate
 * ids are not. Empty when either name has no letter or digit.
 */
export function carrierOptionId(carrier: string, service: string): string {
  const [c, s] = [idPart(carrier), idPart(service)]
  return c === '' || s === '' ? '' : `${c}-${s}`.slice(0, 64)
}

/** A carrier's service as a delivery option, with the names the order records. */
export type CarrierOption = ShippingOption & { carrier: string; service: string }

/**
 * The options a carrier's answer offers: its rates in the store's currency (compared upper-cased) with a non-empty id,
 * the cheapest per id (the first answered among equals), cheapest first and then by id.
 */
export function carrierOptions(rates: readonly CarrierRate[], currency: string): CarrierOption[] {
  const wanted = currency.toUpperCase()
  const cheapest = new Map<string, CarrierRate>()
  for (const rate of rates) {
    if (rate.currency.toUpperCase() !== wanted) continue
    const id = carrierOptionId(rate.carrier, rate.service)
    if (id === '') continue
    const held = cheapest.get(id)
    if (held === undefined || rate.amountMinor < held.amountMinor) cheapest.set(id, rate)
  }
  return [...cheapest]
    .map(([id, rate]) => ({
      id,
      name: `${rate.carrier} ${rate.service}`.trim(),
      amountMinor: rate.amountMinor,
      estimatedDays: rate.estimatedDays,
      carrier: rate.carrier,
      service: rate.service,
    }))
    // The ids are the map's keys, so two are never equal.
    .sort((a, b) => a.amountMinor - b.amountMinor || (a.id < b.id ? -1 : 1))
}

/** A rate the kernel can charge: names it can make an id of, a whole amount ≥ 0 and an ISO 4217 code. */
function validRate(rate: unknown): rate is CarrierRate {
  if (typeof rate !== 'object' || rate === null) return false
  const { carrier, service, amountMinor, currency } = rate as Record<string, unknown>
  return (
    typeof carrier === 'string' &&
    typeof service === 'string' &&
    typeof amountMinor === 'number' &&
    Number.isSafeInteger(amountMinor) &&
    amountMinor >= 0 &&
    typeof currency === 'string' &&
    /^[A-Z]{3}$/.test(currency)
  )
}

export interface CarrierRater {
  /** The options the carrier offers for this parcel from the ship-from address; `shipping_unavailable` when it is down. */
  rate(shipTo: Address, parcel: Parcel): Promise<CarrierOption[]>
}

/**
 * The carrier as checkout uses it. A throw, an answer past the bound, a non-array or a rate the kernel cannot charge is
 * an outage: `checkout.shipping_unavailable`, never a price made up some other way. The adapter's `rate` is looked up on
 * every call.
 */
export function createCarrierRater(deps: {
  adapter: ShippingAdapter
  shipFrom: Address
  currency: string
  boundMs: number
  logger: Logger
}): CarrierRater {
  const { adapter, shipFrom, currency, boundMs, logger } = deps
  return {
    async rate(shipTo, parcel) {
      const params = { from: shipFrom, to: shipTo, parcel }
      let timer: NodeJS.Timeout | undefined
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`carrier past the ${boundMs} ms bound`)), boundMs)
      })
      let failure: unknown
      try {
        const answer: unknown = await Promise.race([
          Promise.resolve().then(() => adapter.rate?.(params)),
          bound,
        ])
        if (Array.isArray(answer) && answer.every(validRate)) {
          const options = carrierOptions(answer, currency)
          const dropped = answer.filter(
            (r) =>
              r.currency.toUpperCase() !== currency.toUpperCase() ||
              carrierOptionId(r.carrier, r.service) === '',
          )
          if (dropped.length > 0) {
            logger.warn(
              {
                provider: adapter.providerName,
                currency,
                dropped: dropped.map(({ carrier, service, currency }) => ({
                  carrier,
                  service,
                  currency,
                })),
              },
              'carrier rates dropped: not in the store currency, or a carrier or service with no letter or digit',
            )
          }
          return options
        }
        failure = new Error('the carrier answered rates the port refuses')
      } catch (err) {
        failure = err
      } finally {
        clearTimeout(timer)
      }
      logger.warn(
        { err: failure, provider: adapter.providerName },
        'carrier unavailable at checkout',
      )
      throw new CheckoutError(
        'shipping_unavailable',
        'The delivery price could not be worked out',
        { cause: failure },
      )
    },
  }
}
