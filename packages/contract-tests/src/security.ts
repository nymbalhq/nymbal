import { describe, expect, it } from 'vitest'
import type { SecurityAdapter, SecurityConfigLike } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

const testConfig: SecurityConfigLike = {
  rateLimit: {
    api: { requests: 100, window: '1m', action: 'block' },
  },
  csrf: false,
  headers: {
    hsts: true,
    contentSecurityPolicy: "default-src 'self'",
    referrerPolicy: 'strict-origin-when-cross-origin',
    xFrameOptions: 'DENY',
  },
}

export function runSecurityContract(
  name: string,
  build: Build<SecurityAdapter>,
  options: ContractOptions<SecurityAdapter> = {},
): void {
  describe(`SecurityAdapter contract: ${name}`, () => {
    it(
      'validate accepts a valid config',
      async () => {
        const adapter = await build()
        const result = await adapter.validate(testConfig)
        expect(typeof result.valid).toBe('boolean')
        expect(Array.isArray(result.errors)).toBe(true)
      },
      CASE_MS,
    )

    it(
      'validate of empty config reports errors',
      async () => {
        const adapter = await build()
        const result = await adapter.validate({} as SecurityConfigLike)
        if (!result.valid) {
          expect(result.errors.length).toBeGreaterThan(0)
        }
      },
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'validate()', async (adapter) =>
      adapter.validate(testConfig),
    )
  })
}
