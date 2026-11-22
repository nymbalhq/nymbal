import { randomUUID } from 'node:crypto'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  AdapterError,
  type Address,
  type Logger,
  type ShippingRate,
  type ShippingRateParams,
  type TaxQuoteParams,
} from '@nymbalhq/types'
import type { Kernel, Seeded } from './kernel.js'
import type { ShippingOptionBody, ShippingRow } from './shipping.js'
import { createTestShipAdapter, type TestShipAdapter } from './test-ship.js'

// Carrier pricing as a checkout test sets it up: a store that prices shipping by its carrier (`pricing: 'carrier'`,
// a ship-from address, a weight for a unit with none) or by its table, beside a rating adapter for the `custom` slot
// (the kernel's test shipping provider) that records every rate call and what it answered, and that a test can hold
// in flight, take down, move a price on, stop answering a service on, or make answer nothing or another currency.
// The parcel and option rules a shopper's checkout is held to are written here, not imported, so the kernel's own
// rules are what the tests check.

/** Where the carrier stores ship from. */
export const WAREHOUSE: Address = {
  firstName: 'Nymbal',
  lastName: 'Warehouse',
  addressLine1: '1 Dock Road',
  city: 'Leeds',
  region: 'West Yorkshire',
  postalCode: 'LS1 4AP',
  country: 'GB',
}

/** What a unit whose variant has no weight weighs on the carrier stores. */
export const DEFAULT_GRAMS = 500

/**
 * The kernel config pricing shipping by the carrier in the `custom` slot, parsed again so the schema's defaults and
 * refusals apply as they do to a merchant's file.
 */
export function withCarrier(
  opts: { defaultWeightGrams?: number; shipFrom?: Address; currency?: string } = {},
): (config: NymbalConfig) => NymbalConfig {
  return (config) =>
    nymbalConfigSchema.parse({
      ...config,
      store: {
        ...config.store,
        shipFrom: opts.shipFrom ?? WAREHOUSE,
        ...(opts.currency !== undefined && { currency: opts.currency }),
      },
      commerce: {
        ...config.commerce,
        shipping: {
          provider: 'custom',
          pricing: 'carrier',
          defaultWeightGrams: opts.defaultWeightGrams ?? DEFAULT_GRAMS,
          rates: [],
        },
      },
    })
}

/** The kernel config pricing shipping by `rows` (none: the free standard option) with the `custom` slot's adapter. */
export function withTablePricing(
  rows: readonly ShippingRow[],
): (config: NymbalConfig) => NymbalConfig {
  return (config) =>
    nymbalConfigSchema.parse({
      ...config,
      commerce: {
        ...config.commerce,
        shipping: { provider: 'custom', pricing: 'table', rates: [...rows] },
      },
    })
}

export type CarrierFault =
  /** The call rejects, as an outage or a refused key. */
  | 'throws'
  /** It answers something that is not an array. */
  | 'not-array'
  /** One rate's amount has half a minor unit. */
  | 'fractional'
  /** One rate's amount is below zero. */
  | 'negative'
  /** Every rate's currency is two letters. */
  | 'currency'

/** A rate call stopped before it answers: `started` resolves once it is in flight. */
export interface HeldRate {
  started: Promise<void>
  release(): void
}

export interface ScriptedCarrier {
  adapter: TestShipAdapter
  providerName: string
  /** Every rate call's params, in order. */
  calls: ShippingRateParams[]
  /** What each call that answered an array answered, in order. */
  answers: ShippingRate[][]
  fail(fault: CarrierFault): void
  /** From now on every call answers no rates. */
  answerNothing(): void
  /** From now on every rate is in `currency`. */
  answerIn(currency: string): void
  /** From now on `service` costs `byMinor` more. */
  move(service: string, byMinor: number): void
  /** From now on `service` is not answered. */
  drop(service: string): void
  /** The next call waits, in flight, until released. */
  holdNext(): HeldRate
  /** Answers as test-ship does again, releasing any call held. */
  recover(): void
}

/**
 * The kernel's test shipping provider with all three words, its `rate` scripted. While well it answers test-ship's
 * own rates: `standard` and `express` from carrier `providerName`, in GBP, a fresh opaque id on every call, at
 * `300 + ceil(grams / 100) × (1 or 2)`.
 */
export function scriptedCarrier(providerName = 'test-ship'): ScriptedCarrier {
  const adapter = createTestShipAdapter({ providerName })
  const own = adapter.rate!.bind(adapter)
  const calls: ShippingRateParams[] = []
  const answers: ShippingRate[][] = []
  let fault: CarrierFault | null = null
  let nothing = false
  let currency: string | null = null
  const moved = new Map<string, number>()
  const dropped = new Set<string>()
  let next: { begin(): void; gate: Promise<void>; release(): void } | null = null
  const held: Array<() => void> = []

  adapter.rate = async (params: ShippingRateParams): Promise<ShippingRate[]> => {
    calls.push(structuredClone(params))
    const hold = next
    next = null
    if (hold !== null) {
      hold.begin()
      await hold.gate
    }
    if (fault === 'throws') {
      throw new AdapterError('shipping.unavailable', `${providerName}: connection refused`)
    }
    let rates = (await own(params))
      .filter((r) => !dropped.has(r.service))
      .map((r) => ({
        ...r,
        amountMinor: r.amountMinor + (moved.get(r.service) ?? 0),
        ...(currency !== null && { currency }),
      }))
    if (nothing) rates = []
    if (fault === 'fractional')
      rates = rates.map((r, i) => (i === 0 ? { ...r, amountMinor: r.amountMinor + 0.5 } : r))
    if (fault === 'negative') rates = rates.map((r, i) => (i === 0 ? { ...r, amountMinor: -1 } : r))
    if (fault === 'currency') rates = rates.map((r) => ({ ...r, currency: 'GB' }))
    if (fault === 'not-array') return { rates } as unknown as ShippingRate[]
    answers.push(structuredClone(rates))
    return rates
  }

  return {
    adapter,
    providerName,
    calls,
    answers,
    fail(what) {
      fault = what
    },
    answerNothing() {
      nothing = true
    },
    answerIn(code) {
      currency = code
    },
    move(service, byMinor) {
      moved.set(service, (moved.get(service) ?? 0) + byMinor)
    },
    drop(service) {
      dropped.add(service)
    },
    holdNext() {
      let begin!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        begin = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      held.push(release)
      next = { begin, gate, release }
      return { started, release }
    },
    recover() {
      fault = null
      nothing = false
      currency = null
      moved.clear()
      dropped.clear()
      next = null
      for (const release of held.splice(0)) release()
    },
  }
}

/** A cart line as the parcel rule reads it. */
export interface WeighedLine {
  weightGrams: number | null
  qty: number
}

/** The documented parcel: Σ max(0, weight ?? default) × qty, rounded up, at least 1 g; no dimensions. */
export function parcelGrams(lines: readonly WeighedLine[], defaultGrams = DEFAULT_GRAMS): number {
  const sum = lines.reduce(
    (total, l) => total + Math.max(0, l.weightGrams ?? defaultGrams) * l.qty,
    0,
  )
  return Math.max(1, Math.ceil(sum))
}

/** An option a carrier store offers, and the carrier and service it was rated as. */
export interface CarrierOffer {
  option: ShippingOptionBody
  carrier: string
  service: string
}

function idPart(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * The documented options for a carrier's answer: rates in the store's currency (any case) whose carrier and service
 * each keep a letter or digit, one per `<carrier>-<service>` id (the cheapest, the first answered among equals), named
 * carrier and service, cheapest first and then by id.
 */
export function offeredBy(rates: readonly ShippingRate[], currency = 'GBP'): CarrierOffer[] {
  const byId = new Map<string, ShippingRate>()
  for (const rate of rates) {
    if (rate.currency.toUpperCase() !== currency.toUpperCase()) continue
    const [c, s] = [idPart(rate.carrier), idPart(rate.service)]
    if (c === '' || s === '') continue
    const id = `${c}-${s}`.slice(0, 64)
    const held = byId.get(id)
    if (held === undefined || rate.amountMinor < held.amountMinor) byId.set(id, rate)
  }
  return [...byId.entries()]
    .map(([id, r]) => ({
      option: {
        id,
        name: `${r.carrier} ${r.service}`.trim(),
        amountMinor: r.amountMinor,
        estimatedDays: r.estimatedDays,
      },
      carrier: r.carrier,
      service: r.service,
    }))
    .sort(
      (a, b) =>
        a.option.amountMinor - b.option.amountMinor ||
        (a.option.id < b.option.id ? -1 : a.option.id > b.option.id ? 1 : 0),
    )
}

/** A product of one variant at `weightGrams` (null: none), through the product service. */
export async function seedWeighted(
  k: Pick<Kernel, 'services'>,
  line: { priceMinor: number; weightGrams: number | null; stock?: number },
): Promise<Seeded & { weightGrams: number | null }> {
  const tag = randomUUID()
  const stock = line.stock ?? 1_000
  const product = await k.services.product.create({
    slug: `parcel-${tag}`,
    name: 'Parcel Widget',
    description: '',
    status: 'active',
    variants: [
      {
        sku: `PARCEL-${tag}`,
        name: 'Default',
        priceMinor: line.priceMinor,
        weightGrams: line.weightGrams,
        stock,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  return {
    productId: product.id,
    variantId: product.variants[0]!.id,
    priceMinor: line.priceMinor,
    initialStock: stock,
    weightGrams: line.weightGrams,
  }
}

/** What a kernel asks its tax engine, recorded on the built adapter (native or injected) as the kernel calls it. */
export function watchTax(k: Kernel): TaxQuoteParams[] {
  const calls: TaxQuoteParams[] = []
  const tax = k.app.adapters.tax
  const quote = tax.quote.bind(tax)
  tax.quote = async (params: TaxQuoteParams) => {
    calls.push(structuredClone(params))
    return quote(params)
  }
  return calls
}

export interface WarnLogger extends Logger {
  /** Everything logged at warn, oldest first, as text. */
  warns: string[]
}

/** A logger that keeps what is logged at warn, so a test can read what an outage told the operator. */
export function warnLogger(): WarnLogger {
  const warns: string[] = []
  const readable = (_key: string, value: unknown) =>
    value instanceof Error ? { name: value.name, message: value.message } : value
  const logger: WarnLogger = {
    warns,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (entry: unknown, msg?: string) => {
      warns.push(`${JSON.stringify(entry, readable)} ${msg ?? ''}`)
    },
    error: () => undefined,
    child: () => logger,
  }
  return logger
}
