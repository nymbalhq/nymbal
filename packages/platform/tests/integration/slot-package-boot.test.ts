import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { createKernel } from '../support/kernel.js'

// AC-8, the kernel half: `package` on a commerce slot block is metadata for tooling, and the kernel ignores it. The
// same store with a package named on every commerce slot boots, keeps each name, and reports the same providers and
// capabilities.

const SLOTS = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const

function withPackages(config: NymbalConfig): NymbalConfig {
  const commerce: Record<string, unknown> = { ...config.commerce }
  for (const slot of SLOTS) {
    commerce[slot] = { ...(config.commerce[slot] as object), package: `@acme/nymbal-${slot}` }
  }
  return nymbalConfigSchema.parse({ ...config, commerce })
}

describe('AC-8: the kernel ignores commerce.<slot>.package', () => {
  it('AC-8: a store whose every commerce slot names a package boots, keeps the names, and reports the same providers and capabilities as the store without them', async () => {
    const plain = await createKernel({ dialect: 'sqlite' })
    const named = await createKernel({ dialect: 'sqlite', configure: withPackages })
    try {
      const kept = SLOTS.map(
        (slot) => (named.config.commerce[slot] as { package?: string }).package,
      )

      expect(kept).toEqual(SLOTS.map((slot) => `@acme/nymbal-${slot}`))
      expect(named.app.capabilities()).toEqual(plain.app.capabilities())
    } finally {
      await named.close()
      await plain.close()
    }
  }, 60_000)
})
