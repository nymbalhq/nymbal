import { describe, expect, it } from 'vitest'
import type { AnalyticsAdapter } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

export function runAnalyticsContract(
  name: string,
  build: Build<AnalyticsAdapter>,
  options: ContractOptions<AnalyticsAdapter> = {},
): void {
  describe(`AnalyticsAdapter contract: ${name}`, () => {
    it(
      'track resolves without throwing',
      async () => {
        const adapter = await build()
        await expect(
          adapter.track('product_viewed', { productId: 'prod-1', source: 'test' }),
        ).resolves.not.toThrow()
      },
      CASE_MS,
    )

    it(
      'identify resolves without throwing',
      async () => {
        const adapter = await build()
        await expect(
          adapter.identify('user-1', { email: 'test@example.com', plan: 'free' }),
        ).resolves.not.toThrow()
      },
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'track()', (adapter) =>
      adapter.track('product_viewed', { productId: 'prod-1', source: 'contract-down' }),
    )
  })
}
