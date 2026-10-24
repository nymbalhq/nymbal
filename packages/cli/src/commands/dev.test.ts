import { describe, it, expect } from 'vitest'
import { parseArgs, type ArgsDef } from 'citty'
import { devCommand, defaultStorefrontPort, preferredStorefrontPort } from './dev.js'

/**
 * Regression guard for the `nymbal dev --api-only` flag.
 *
 * citty 0.1.6 does not kebab-case flags: the arg key is `apiOnly`, so a bare
 * definition only recognises `--apiOnly`. A `--api-only` flag (what `--help`
 * renders, what tests/e2e/playwright.config.ts passes, and what a developer
 * would type) used to be silently dropped because citty applies `default:
 * false` and `args.apiOnly` resolves the `false` default before the kebab
 * fallback. The `alias: 'api-only'` on the arg makes mri map `--api-only`
 * straight to `apiOnly`. Both forms must resolve to `true`, and the flag must
 * still default to `false` when absent.
 *
 * Deletion test: remove the alias from dev.ts and the `--api-only` case below
 * goes back to `false` and fails.
 */
describe('nymbal dev --api-only flag parsing', () => {
  // devCommand.args is typed Resolvable<ArgsDef> (citty allows a lazy/async
  // args factory). Our definition is a plain object, so narrow it for parseArgs.
  const args = devCommand.args as ArgsDef

  it('honours the kebab-case --api-only flag', () => {
    expect(parseArgs(['--api-only'], args).apiOnly).toBe(true)
  })

  it('honours the camelCase --apiOnly flag', () => {
    expect(parseArgs(['--apiOnly'], args).apiOnly).toBe(true)
  })

  it('defaults apiOnly to false when the flag is absent', () => {
    expect(parseArgs([], args).apiOnly).toBe(false)
  })

  it('disables apiOnly with --no-api-only', () => {
    expect(parseArgs(['--no-api-only'], args).apiOnly).toBe(false)
  })

  it('still parses --seed independently of apiOnly', () => {
    const parsed = parseArgs(['--api-only', '--no-seed'], args)
    expect(parsed.apiOnly).toBe(true)
    expect(parsed.seed).toBe(false)
  })

  it('exposes a --storefront-port flag (kebab alias) documented in help', () => {
    expect(parseArgs(['--storefront-port', '4399'], args).storefrontPort).toBe('4399')
    const storefrontArg = (args as Record<string, { description?: string }>)['storefrontPort']
    expect(storefrontArg?.description).toMatch(/storefront dev server/i)
  })
})

/**
 * Storefront port resolution. The headline `nymbal dev` must default to the
 * template's conventional port but let the developer override it (flag > env >
 * default), so a busy 4321/3000 never blocks the launch.
 */
describe('storefront port preference', () => {
  it('uses the template default when no flag or env is set', () => {
    expect(defaultStorefrontPort('astro')).toBe(4321)
    expect(defaultStorefrontPort('nextjs')).toBe(3000)
    expect(preferredStorefrontPort('astro', undefined, {})).toBe(4321)
    expect(preferredStorefrontPort('nextjs', undefined, {})).toBe(3000)
  })

  it('honours NYMBAL_STOREFRONT_PORT over the default', () => {
    expect(preferredStorefrontPort('astro', undefined, { NYMBAL_STOREFRONT_PORT: '4399' })).toBe(
      4399,
    )
  })

  it('honours the --storefront-port flag over the env var', () => {
    expect(preferredStorefrontPort('astro', 5050, { NYMBAL_STOREFRONT_PORT: '4399' })).toBe(5050)
  })

  it('ignores a blank or non-numeric NYMBAL_STOREFRONT_PORT and uses the default', () => {
    expect(preferredStorefrontPort('astro', undefined, { NYMBAL_STOREFRONT_PORT: '' })).toBe(4321)
    expect(preferredStorefrontPort('astro', undefined, { NYMBAL_STOREFRONT_PORT: 'abc' })).toBe(
      4321,
    )
  })
})
