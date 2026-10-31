import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import { loadConfig, PROVIDER_NAME } from './index.js'

// AC-1: a commerce slot's provider and `security.adapter` take any name PROVIDER_NAME matches, and keep it; any other
// name fails naming the slot, the value and the pattern. `package` beside a built-in, `security.adapter 'custom'`, and
// `security.config` beside middleware or cloudflare fail loadConfig.

const COMMERCE = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const
type Commerce = (typeof COMMERCE)[number]

/** Each commerce slot's built-in provider. */
const BUILT_IN: Record<Commerce, string> = {
  payments: 'native',
  email: 'native',
  reviews: 'native',
  search: 'native',
  analytics: 'native',
  shipping: 'native',
  tax: 'native',
  ai: 'none',
}

const CLOUDFLARE = { zoneId: 'zone-ac1', apiToken: 'token-ac1' }

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function baseConfig(): Record<string, unknown> & {
  commerce: Record<string, unknown>
  security: Record<string, unknown>
} {
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: Object.fromEntries(COMMERCE.map((s) => [s, { provider: BUILT_IN[s] }])),
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
  }
}

function withBlock(slot: Commerce, block: Record<string, unknown>) {
  const config = baseConfig()
  config.commerce[slot] = block
  return config
}

function withSecurity(security: Record<string, unknown>) {
  const config = baseConfig()
  config.security = security
  return config
}

function project(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'open-providers-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  return dir
}

/** loadConfig's rejection, or null when it loaded. */
function rejectionOf(config: unknown): Promise<unknown> {
  return loadConfig(project(config)).then(
    () => null,
    (error: unknown) => error,
  )
}

function messageOf(error: unknown): string {
  expect(error, 'loadConfig accepted it').toBeInstanceOf(ConfigError)
  return (error as ConfigError).message
}

const quoted = (message: string, value: string): boolean =>
  [`'${value}'`, `"${value}"`, `\`${value}\``].some((q) => message.includes(q))

/** The pattern as a message would print it: PROVIDER_NAME's source, anchored or not. */
const namesPattern = (message: string): boolean =>
  message.includes(PROVIDER_NAME.source) || message.includes(PROVIDER_NAME.source.slice(1, -1))

const providerName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,30}$/)

/** Names the pattern refuses: an upper-case letter, a path, a leading hyphen, punctuation, a scope, nothing. */
const malformed = fc.oneof(
  fc.constantFrom('Stripe', '../x', '-x', 'a_b', 'a.b', '@acme/x', '', 'a b', 'stripé'),
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !/^[a-z0-9][a-z0-9-]*$/.test(s)),
)

describe('AC-1: provider names are open', () => {
  it('AC-1: every commerce slot accepts any provider PROVIDER_NAME matches, and keeps it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...COMMERCE), providerName, async (slot, provider) => {
        expect(PROVIDER_NAME.test(provider)).toBe(true)
        const loaded = await loadConfig(project(withBlock(slot, { provider })))
        expect(loaded.config.commerce[slot].provider, `${slot}: ${provider}`).toBe(provider)
      }),
      { numRuns: 30 },
    )
  })

  it('AC-1: security.adapter accepts any PROVIDER_NAME but custom and cloudflare (which needs its own block), and keeps it', async () => {
    await fc.assert(
      fc.asyncProperty(
        providerName.filter((p) => p !== 'custom' && p !== 'cloudflare'),
        async (adapter) => {
          const loaded = await loadConfig(project(withSecurity({ adapter })))
          expect(loaded.config.security.adapter).toBe(adapter)
        },
      ),
      { numRuns: 20 },
    )
  })

  it('AC-1: a provider PROVIDER_NAME refuses fails loadConfig naming the slot, the value and the pattern, on every commerce slot and on security.adapter', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Commerce | 'security'>(...COMMERCE, 'security'),
        malformed,
        async (slot, name) => {
          const config =
            slot === 'security'
              ? withSecurity({ adapter: name })
              : withBlock(slot, { provider: name })
          const message = messageOf(await rejectionOf(config))

          expect(message).toMatch(new RegExp(`\\b${slot}\\b`))
          expect(
            quoted(message, name),
            `the message quotes ${JSON.stringify(name)}: ${message}`,
          ).toBe(true)
          expect(namesPattern(message), message).toBe(true)
        },
      ),
      { numRuns: 30 },
    )
  })
})

describe('AC-1: what a block cannot hold', () => {
  it('AC-1: package beside a built-in provider fails naming both; the same block without package loads', async () => {
    const cases = [
      ...COMMERCE.map((slot) => ({
        label: `${slot} ${BUILT_IN[slot]}`,
        provider: BUILT_IN[slot],
        withPackage: withBlock(slot, { provider: BUILT_IN[slot], package: '@acme/nymbal-builtin' }),
        without: withBlock(slot, { provider: BUILT_IN[slot] }),
      })),
      {
        label: 'security middleware',
        provider: 'middleware',
        withPackage: withSecurity({ adapter: 'middleware', package: '@acme/nymbal-builtin' }),
        without: withSecurity({ adapter: 'middleware' }),
      },
    ]
    for (const c of cases) {
      const message = messageOf(await rejectionOf(c.withPackage))
      expect(quoted(message, c.provider), `${c.label}: ${message}`).toBe(true)
      expect(message, c.label).toMatch(/\bpackage\b/)
      expect(await rejectionOf(c.without), c.label).toBeNull()
    }
  })

  it("AC-1: security.adapter 'custom' fails loadConfig naming package:, the way to a third-party adapter, with or without a package", async () => {
    for (const security of [
      { adapter: 'custom' },
      { adapter: 'custom', package: '@acme/nymbal-security' },
    ]) {
      const message = messageOf(await rejectionOf(withSecurity(security)))
      expect(message).toMatch(/\bsecurity\b/)
      expect(quoted(message, 'custom'), message).toBe(true)
      expect(message).toContain('package:')
    }
  })

  it('AC-1: security.config beside middleware or cloudflare fails loadConfig; beside a third-party adapter it loads and is kept', async () => {
    const config = { apiToken: 't' }
    const middleware = messageOf(await rejectionOf(withSecurity({ adapter: 'middleware', config })))
    const cloudflare = messageOf(
      await rejectionOf(withSecurity({ adapter: 'cloudflare', cloudflare: CLOUDFLARE, config })),
    )
    const loaded = await loadConfig(
      project(withSecurity({ adapter: 'acme', package: '@acme/nymbal-security', config })),
    )

    expect(middleware).toMatch(/security\.config/)
    expect(quoted(middleware, 'middleware'), middleware).toBe(true)
    expect(cloudflare).toMatch(/security\.config/)
    expect(quoted(cloudflare, 'cloudflare'), cloudflare).toBe(true)
    const security = loaded.config.security as unknown as Record<string, unknown>
    expect(security['config']).toEqual(config)
    expect(security['package']).toBe('@acme/nymbal-security')
    // Without config, cloudflare and middleware load as before.
    expect(
      await rejectionOf(withSecurity({ adapter: 'cloudflare', cloudflare: CLOUDFLARE })),
    ).toBeNull()
    expect(await rejectionOf(withSecurity({ adapter: 'middleware' }))).toBeNull()
  })
})
