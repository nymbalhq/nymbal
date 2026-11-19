import type { NymbalConfig } from '@nymbalhq/config'
import type {
  Address,
  TaxAdapter,
  TaxCapability,
  TaxQuote,
  TaxQuoteLine,
  TaxQuoteParams,
} from '@nymbalhq/types'
import { address } from './kernel.js'

// Tax as a checkout test sets it up: the store's tax config (a rate table, the inclusive flag, the outage setting, a
// ship-from address), destinations the table does and does not cover, the exact integer maths a shopper's tax is held
// to (written here, not imported, so the kernel's own maths is what the tests check), and a provider a test scripts
// for the `custom` slot, which records every request and can fail in each way the kernel must treat as an outage.

export interface RateRow {
  country: string
  region?: string
  percent: number
  codes?: Record<string, number>
}

export interface TaxSetup {
  provider?: 'native' | 'custom'
  rates?: RateRow[]
  pricesIncludeTax?: boolean
  onUnavailable?: 'refuse' | 'native'
  shipFrom?: Address
}

/** The kernel config with the store's tax set as `setup` says; everything else as the harness has it. */
export function withTax(setup: TaxSetup): (config: NymbalConfig) => NymbalConfig {
  return (config) =>
    ({
      ...config,
      store: {
        ...config.store,
        pricesIncludeTax: setup.pricesIncludeTax ?? false,
        ...(setup.shipFrom !== undefined && { shipFrom: setup.shipFrom }),
      },
      commerce: {
        ...config.commerce,
        tax: {
          provider: setup.provider ?? 'native',
          onUnavailable: setup.onUnavailable ?? 'refuse',
          rates: setup.rates ?? [],
        },
      },
    }) as NymbalConfig
}

/** The rows every taxed kernel of the checkout suites collects in. */
export const RATES: RateRow[] = [
  { country: 'GB', percent: 20 },
  { country: 'US', region: 'CA', percent: 7.25 },
  { country: 'US', region: 'NY', percent: 8.875 },
  { country: 'DE', percent: 19 },
]

/** A destination and the percent the table taxes it at. */
export interface Destination {
  shipTo: Address
  percent: number
}

export const DESTINATIONS: readonly Destination[] = [
  { shipTo: address, percent: 20 },
  {
    shipTo: { ...address, city: 'Los Angeles', region: 'CA', postalCode: '90001', country: 'US' },
    percent: 7.25,
  },
  {
    shipTo: { ...address, city: 'Albany', region: 'New York', postalCode: '12207', country: 'US' },
    percent: 8.875,
  },
  {
    shipTo: { ...address, city: 'Berlin', region: '', postalCode: '10115', country: 'DE' },
    percent: 19,
  },
]

/** Outside every row: the store does not collect there. */
export const UNTAXED: Address = {
  ...address,
  city: 'Tokyo',
  region: 'Tokyo',
  postalCode: '100-0001',
  country: 'JP',
}

const MILLION = 1_000_000n

/** Parts per million of a percent with at most four decimals. */
export function ppm(percent: number): bigint {
  return BigInt(Math.round(percent * 10_000))
}

/** Tax added to `amountMinor` at `percent`: A × p / 100, rounded half up. */
export function taxOnTop(amountMinor: number, percent: number): number {
  return Number((BigInt(amountMinor) * ppm(percent) + MILLION / 2n) / MILLION)
}

/** Tax contained in `amountMinor` at `percent`: A less its net A × 10⁶ / (10⁶ + r), the net rounded half up. */
export function taxWithin(amountMinor: number, percent: number): number {
  const r = ppm(percent)
  const net = (2n * BigInt(amountMinor) * MILLION + (MILLION + r)) / (2n * (MILLION + r))
  return amountMinor - Number(net)
}

export type Outage = 'throws' | 'bound' | 'invalid'

export interface ScriptedTax {
  adapter: TaxAdapter
  /** Every request, in order. */
  calls: TaxQuoteParams[]
  /** Every quote answered, in order: a failed call answers none. */
  answers: TaxQuote[]
  /** The percent each line is taxed at while the provider is up. */
  percent: number
  /** Fails every call from now on: a rejection, an answer that never comes, or a quote the port refuses. */
  fail(outage: Outage): void
  /** Answers again; a call left hanging is rejected, so nothing waits on it past the test. */
  recover(): void
}

/**
 * A tax provider for the `custom` slot. While up it answers a valid quote taxing each line `percent` on top or within
 * (by the request's flag), with a quote id and a jurisdiction per line, so a test can tell its whole answer apart.
 */
export function scriptedTax(
  opts: { percent?: number; capabilities?: TaxCapability[]; providerName?: string } = {},
): ScriptedTax {
  let outage: Outage | null = null
  let hung: Array<(err: Error) => void> = []
  let quoted = 0
  const state: ScriptedTax = {
    calls: [],
    answers: [],
    percent: opts.percent ?? 10,
    fail(next) {
      outage = next
    },
    recover() {
      outage = null
      for (const reject of hung) reject(new Error('scripted tax provider recovered'))
      hung = []
    },
    adapter: {
      kind: 'tax',
      providerName: opts.providerName ?? 'scripted-tax',
      producesEvents: [],
      consumesEvents: [],
      initialize: async () => undefined,
      healthCheck: async () => ({ status: 'healthy' as const }),
      capabilities: () => opts.capabilities ?? ['quote', 'inclusive'],
      async quote(params: TaxQuoteParams): Promise<TaxQuote> {
        state.calls.push(structuredClone(params))
        if (outage === 'throws') throw new Error('scripted tax provider unreachable')
        if (outage === 'bound') {
          return new Promise<TaxQuote>((_, reject) => {
            hung.push(reject)
          })
        }
        const percent = state.percent
        const rate = Number(ppm(percent))
        const lines = params.lines.map((line: TaxQuoteLine) => {
          const taxMinor = params.pricesIncludeTax
            ? taxWithin(line.amountMinor, percent)
            : taxOnTop(line.amountMinor, percent)
          return {
            id: line.id,
            taxableMinor: line.amountMinor,
            taxMinor,
            ratePpm: rate,
            jurisdictions: [
              { name: 'Scripted', level: 'country', ratePpm: rate, amountMinor: taxMinor },
            ],
          }
        })
        const total = lines.reduce((sum: number, l: { taxMinor: number }) => sum + l.taxMinor, 0)
        quoted += 1
        const answer: TaxQuote = {
          provider: 'scripted-tax',
          inclusive: params.pricesIncludeTax,
          lines,
          shippingTaxMinor: 0,
          // An invalid quote: the total is not the sum of its lines.
          totalTaxMinor: outage === 'invalid' ? total + 1 : total,
          quoteId: `scripted-${quoted}`,
        }
        if (outage !== 'invalid') state.answers.push(structuredClone(answer))
        return answer
      },
    },
  }
  return state
}

/** Whether a boolean column as either dialect hands it back (SQLite 0/1, Postgres true/false) is set. */
export function flagOf(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't'
}
