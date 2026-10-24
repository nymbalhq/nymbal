import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { KNOWN_PROVIDERS } from './known-providers.js'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// AC-8, the schema half: every commerce slot block takes an optional `package`, a valid npm package name kept as
// written; anything else is refused with the issue at that slot's `package`.

type Slot = keyof typeof KNOWN_PROVIDERS
const SLOTS = Object.keys(KNOWN_PROVIDERS) as Slot[]

function input(slot: Slot, pkg: unknown): NymbalConfigInput {
  const commerce: Record<string, Record<string, unknown>> = {
    payments: { provider: 'native' },
    email: { provider: 'native' },
    reviews: { provider: 'native' },
    search: { provider: 'native' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: { provider: 'none' },
  }
  commerce[slot] = { provider: 'custom', package: pkg, config: { region: 'eu' } }
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: { commandStore: 'sqlite', documentStore: 'in-memory', eventBus: 'in-process' },
    security: { adapter: 'middleware' },
    commerce,
    http: { adapter: 'fastify' },
    deployment: { strategy: 'standard' },
  } as unknown as NymbalConfigInput
}

/** Names npm publishes today: lower case, URL-safe, scoped or not, at least four characters (no core module name). */
const part = fc.stringMatching(/^[a-z][a-z0-9-]{3,20}(\.[a-z0-9]{1,5})?$/)
const validName = fc.oneof(
  part,
  fc.tuple(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,12}$/), part).map(([s, n]) => `@${s}/${n}`),
)
/** One character npm refuses anywhere in a name, put somewhere in a valid one. */
const malformedName = fc
  .tuple(
    validName,
    fc.constantFrom(' ', '"', '<', '>', '\\', '^', '`', '{', '|', '}', '#', '?', '%'),
    fc.nat(),
  )
  .map(([name, bad, at]) => {
    const i = at % (name.length + 1)
    return `${name.slice(0, i)}${bad}${name.slice(i)}`
  })

const issueAt = (slot: Slot, pkg: unknown): string[] => {
  const parsed = nymbalConfigSchema.safeParse(input(slot, pkg))
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))
}

describe('AC-8: commerce.<slot>.package', () => {
  it('AC-8: for any commerce slot and any valid npm name, scoped or not, the config parses and keeps the name as written', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SLOTS), validName, (slot, name) => {
        const parsed = nymbalConfigSchema.parse(input(slot, name))
        const block = parsed.commerce[slot] as { package?: unknown; config?: unknown }
        expect(block.package).toBe(name)
        expect(block.config).toEqual({ region: 'eu' })
      }),
      { numRuns: 200 },
    )
  })

  it('AC-8: for any commerce slot, a name with a character npm refuses is rejected, with the issue at that slot’s package', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SLOTS), malformedName, (slot, name) => {
        expect(issueAt(slot, name)).toContain(`commerce.${slot}.package`)
      }),
      { numRuns: 200 },
    )
  })

  it('AC-8: the malformed names npm names in its rules, and a value that is not a string, are rejected at the slot’s package', () => {
    const malformed: unknown[] = [
      '',
      '.hidden',
      '_private',
      '@scope/',
      '@/name',
      'a/b',
      '@scope/a/b',
      'naïve',
      `n${'x'.repeat(214)}`,
      42,
      { name: 'x' },
    ]
    const accepted = malformed.filter(
      (pkg) => !issueAt('search', pkg).includes('commerce.search.package'),
    )
    expect(accepted).toEqual([])
    expect(issueAt('search', '@acme/nymbal-search').length).toBeLessThan(
      issueAt('search', '').length,
    )
  })
})
