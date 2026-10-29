import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import { KNOWN_PROVIDERS, loadConfig, type CommerceSlot } from './index.js'

// AC-1: every slot's provider is one of KNOWN_PROVIDERS[slot] or `custom`; any other string fails loadConfig naming
// the slot, the string and the known list, and a `native` email block asking for SMTP fails naming `smtp`.

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
  email: ['native', 'smtp', 'mailgun', 'resend'],
  ai: ['none', 'anthropic'],
  reviews: ['native'],
  search: ['native'],
  analytics: ['native'],
  shipping: ['native', 'easypost'],
  tax: ['native'],
}

/** Every provider name any slot knows: a generated string outside it is unknown to every slot. */
const EVERY_NAME = new Set([...Object.values(SPEC_PROVIDERS).flat(), 'custom'])

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
      documentStore: 'in-memory',
      eventBus: 'in-process',
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

function quoted(message: string, value: string): boolean {
  return [`'${value}'`, `"${value}"`, `\`${value}\``].some((q) => message.includes(q))
}

/** Strings no slot lists: random provider-shaped names, and one-character typos of the listed ones. */
const unknownProvider = fc
  .oneof(
    fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,24}$/),
    fc
      .tuple(fc.constantFrom(...EVERY_NAME), fc.stringMatching(/^[a-z0-9-]$/), fc.nat())
      .map(([name, c, at]) => {
        const i = at % (name.length + 1)
        return `${name.slice(0, i)}${c}${name.slice(i)}`
      }),
  )
  .filter((s) => !EVERY_NAME.has(s))

describe('AC-1: the config knows its providers', () => {
  it('AC-1: KNOWN_PROVIDERS lists, per slot, exactly the known providers (custom aside)', () => {
    expect(Object.keys(KNOWN_PROVIDERS).sort()).toEqual([...SLOTS].sort())
    for (const slot of SLOTS) {
      const listed = known(slot).filter((p) => p !== 'custom')
      expect([...listed].sort(), slot).toEqual([...SPEC_PROVIDERS[slot]].sort())
    }
  })

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

  it('AC-1: any other provider string fails loadConfig with a ConfigError naming the slot, the string and every known provider for that slot', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...SLOTS), unknownProvider, async (slot, provider) => {
        const error = await rejectionOf(withBlock(slot, { provider }))

        expect(error, `${slot}: ${provider} loaded`).toBeInstanceOf(ConfigError)
        const message = (error as ConfigError).message
        expect(message).toMatch(new RegExp(`\\b${slot}\\b`))
        expect(quoted(message, provider), `the message quotes ${provider}: ${message}`).toBe(true)
        const unnamed = SPEC_PROVIDERS[slot].filter((known) => !message.includes(known))
        expect(unnamed, message).toEqual([])
      }),
      { numRuns: 40 },
    )
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
