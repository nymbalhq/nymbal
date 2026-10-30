import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, type CommerceSlot } from './index.js'

// AC-5: loadConfig imports the config module once and returns its default export as the config and its named
// `adapters` export beside it, so `nymbal dev` can hand them to createApp.

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../tests/e2e/fixtures/custom-providers/', import.meta.url),
)

const SLOTS = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const satisfies readonly CommerceSlot[]

type Loaded = Awaited<ReturnType<typeof loadConfig>> & {
  adapters?: Partial<
    Record<CommerceSlot, { providerName?: string; capabilities(): readonly string[] }>
  >
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function baseConfig(custom: readonly CommerceSlot[]) {
  const commerce: Record<string, { provider: string }> = {
    payments: { provider: 'native' },
    email: { provider: 'native' },
    reviews: { provider: 'native' },
    search: { provider: 'native' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: { provider: 'none' },
  }
  for (const slot of custom) commerce[slot] = { provider: 'custom' }
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce,
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
  }
}

/** A project whose nymbal.config.ts default-exports the config and exports one adapter per slot in `adapters`. */
function project(custom: readonly CommerceSlot[], adapters: readonly CommerceSlot[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'caps-config-'))
  dirs.push(dir)
  const exported = `export const adapters = {\n${adapters
    .map(
      (slot) =>
        `  ${slot}: { kind: '${slot}', providerName: 'caps-${slot}', capabilities: () => ['caps-${slot}'] },`,
    )
    .join('\n')}\n}\n`
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `${exported}export default ${JSON.stringify(baseConfig(custom), null, 2)}\n`,
  )
  return dir
}

describe('loadConfig returns the config module’s adapters export', () => {
  it('AC-5: the custom-providers fixture loads with its search and payments adapters, one per custom slot', async () => {
    const loaded = (await loadConfig(FIXTURE_DIR)) as Loaded

    const customSlots = SLOTS.filter((slot) => loaded.config.commerce[slot].provider === 'custom')
    expect(customSlots).toEqual(['payments', 'search'])
    expect(Object.keys(loaded.adapters ?? {}).sort()).toEqual([...customSlots].sort())
    expect(loaded.adapters?.search?.capabilities().includes('facet')).toBe(false)
    expect(loaded.config.http.port).toBe(3011)
  })

  it('AC-5: over generated slot sets, the adapters loadConfig returns are exactly the ones the module exports, each its own', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray([...SLOTS], { minLength: 1 }), async (slots) => {
        const loaded = (await loadConfig(project(slots, slots))) as Loaded

        expect(Object.keys(loaded.adapters ?? {}).sort()).toEqual([...slots].sort())
        for (const slot of slots) {
          expect(loaded.adapters?.[slot]?.providerName).toBe(`caps-${slot}`)
          expect(loaded.adapters?.[slot]?.capabilities()).toEqual([`caps-${slot}`])
        }
        // The config is still the default export, parsed as before.
        expect(SLOTS.filter((s) => loaded.config.commerce[s].provider === 'custom').sort()).toEqual(
          [...slots].sort(),
        )
      }),
      { numRuns: 15 },
    )
  })
})
