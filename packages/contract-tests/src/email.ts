import { describe, expect, it } from 'vitest'
import type { EmailAdapter } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

const MAIL = {
  template: 'order-confirmation',
  to: 'test@example.com',
  vars: { orderNumber: 'ORD-001' },
}

export function runEmailContract(
  name: string,
  build: Build<EmailAdapter>,
  options: ContractOptions<EmailAdapter> = {},
): void {
  describe(`EmailAdapter contract: ${name}`, () => {
    it(
      'sendTransactional resolves with accepted or messageId',
      async () => {
        const adapter = await build()
        const result = await adapter.sendTransactional(MAIL)
        expect(typeof result.accepted).toBe('boolean')
      },
      CASE_MS,
    )

    it(
      'syncCustomerToList resolves without throwing',
      async () => {
        const adapter = await build()
        await expect(
          adapter.syncCustomerToList({
            customerId: 'cust-1',
            orderCount: 0,
            totalSpentMinor: 0,
            segment: 'new',
            createdAt: new Date().toISOString(),
          }),
        ).resolves.not.toThrow()
      },
      CASE_MS,
    )

    it(
      'removeCustomerFromList resolves without throwing',
      async () => {
        const adapter = await build()
        await expect(adapter.removeCustomerFromList('cust-1')).resolves.not.toThrow()
      },
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'sendTransactional()', (adapter) =>
      adapter.sendTransactional(MAIL),
    )
  })
}
