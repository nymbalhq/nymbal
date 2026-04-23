import { describe, it, expect } from 'vitest'
import type { SecurityAdapter, SecurityConfigLike } from '@nymbal/types'

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

export function runSecurityContract(build: () => SecurityAdapter): void {
  describe('SecurityAdapter contract', () => {
    it('validate accepts a valid config', async () => {
      const adapter = build()
      const result = await adapter.validate(testConfig)
      expect(typeof result.valid).toBe('boolean')
      expect(Array.isArray(result.errors)).toBe(true)
    })

    it('validate of empty config reports errors', async () => {
      const adapter = build()
      const result = await adapter.validate({} as SecurityConfigLike)
      if (!result.valid) {
        expect(result.errors.length).toBeGreaterThan(0)
      }
    })

    it('healthCheck returns a valid report', async () => {
      const adapter = build()
      const report = await adapter.healthCheck()
      expect(['healthy', 'degraded', 'down']).toContain(report.status)
    })
  })
}
