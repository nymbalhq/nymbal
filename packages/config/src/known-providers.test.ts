import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import { KNOWN_PROVIDERS, loadConfig, type CommerceSlot } from './index.js'

// AC-1: every slot loads each of KNOWN_PROVIDERS[slot] and `custom`, keeping it, and a `native` email block asking for
// SMTP fails naming `smtp`. Open provider names are open-providers.test.ts.

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
type Slot = (typeof SLOTS)[number]

/** The config's list for a slot (the interface under test). */
const known = (slot: Slot): readonly string[] => KNOWN_PROVIDERS[slot]

/** The known providers, per slot, without `custom` (which every slot also accepts). */
const SPEC_PROVIDERS: Record<Slot, readonly string[]> = {
  payments: ['native', 'stripe'],
  email: ['native', 'smtp', 'mailgun', 'resend', 'ses'],
  ai: ['none', 'anthropic'],
  reviews: ['native'],
  search: ['native'],
  analytics: ['native'],
  shipping: ['native', 'easypost'],
  tax: ['native'],
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function baseConfig(): Record<string, unknown> & { commerce: Record<string, unknown> } {
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
  }
}

function withBlock(slot: Slot, block: Record<string, unknown>) {
  const config = baseConfig()
  config.commerce[slot] = block
  return config
}

/** Writes `config` as a project's nymbal.config.ts in a fresh directory and returns the directory. */
function project(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapters-config-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  return dir
}

/** loadConfig's rejection, or null when it loaded. */
async function rejectionOf(config: unknown): Promise<unknown> {
  return loadConfig(project(config)).then(
    () => null,
    (error: unknown) => error,
  )
}

describe('AC-1: the config knows its providers', () => {
  it('AC-1: loadConfig accepts every slot × every known provider, and custom, and keeps the provider it was given', async () => {
    const cells = SLOTS.flatMap((slot) =>
      [...new Set([...known(slot), 'custom'])].map((provider) => ({ slot, provider })),
    )
    expect(cells.length).toBeGreaterThanOrEqual(
      Object.values(SPEC_PROVIDERS).flat().length + SLOTS.length,
    )
    for (const { slot, provider } of cells) {
      const loaded = await loadConfig(project(withBlock(slot, { provider })))
      expect(loaded.config.commerce[slot].provider, `${slot}: ${provider}`).toBe(provider)
    }
  })

  it("AC-1: email { provider: 'native', config: { transport: 'smtp' } } fails loadConfig naming smtp, where the same block on the console transport loads", async () => {
    const smtp = { host: 'localhost', port: 1025 }
    const asSmtp = withBlock('email', {
      provider: 'native',
      config: { transport: 'smtp', smtp },
    })
    const asConsole = withBlock('email', {
      provider: 'native',
      config: { transport: 'console' },
    })

    const error = await rejectionOf(asSmtp)
    const loaded = await rejectionOf(asConsole)

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).message).toMatch(/\bemail\b/)
    expect((error as ConfigError).message).toContain('smtp')
    expect(loaded).toBeNull()
  })
})
