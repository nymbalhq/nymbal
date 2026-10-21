import { describe, expect, it } from 'vitest'
import type { ShippingAdapter } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

const REQUEST = {
  fromPostalCode: 'SW1A 1AA',
  toPostalCode: 'EC1A 1BB',
  toCountry: 'GB',
  weightGrams: 500,
  currency: 'GBP',
}

export function runShippingContract(
  name: string,
  build: Build<ShippingAdapter>,
  options: ContractOptions<ShippingAdapter> = {},
): void {
  describe(`ShippingAdapter contract: ${name}`, () => {
    it(
      'rate returns an array of shipping options',
      async () => {
        const adapter = await build()
        const rates = await adapter.rate(REQUEST)
        expect(Array.isArray(rates)).toBe(true)
        if (rates.length > 0) {
          const rate = rates[0]!
          expect(typeof rate.amountMinor).toBe('number')
          expect(typeof rate.carrier).toBe('string')
          expect(typeof rate.estimatedDays).toBe('number')
        }
      },
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'rate()', (adapter) => adapter.rate(REQUEST))
  })
}
