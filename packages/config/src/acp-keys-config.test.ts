import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// `agents.acp.keys`: each shopping assistant's ACP key, by name. The name becomes the order source `agent:<name>` and
// the audit actor `acp:<name>`, so it is held to a label's shape; the key is a secret, so no refusal prints one.

/** The name rule as the store documents it, written out here so the test does not take it from the code. */
const NAME_RULE = /^[a-z0-9][a-z0-9._-]{0,39}$/

function baseConfig(): NymbalConfigInput {
  return {
    store: { name: 'Test', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    } as unknown as NymbalConfigInput['infrastructure'],
    security: { adapter: 'middleware', rateLimit: {}, csrf: true },
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
    http: { adapter: 'fastify', port: 3001, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  }
}

interface Issue {
  path: string
  message: string
}

/** The issues of `agents.acp` as given, or [] when it parses. */
function issuesOf(acp: Record<string, unknown>): Issue[] {
  const result = nymbalConfigSchema.safeParse({ ...baseConfig(), agents: { acp } })
  return result.success
    ? []
    : result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

/** The distinct paths refused, in order: one field may carry more than one message. */
const pathsOf = (issues: Issue[]) => [...new Set(issues.map((i) => i.path))]

function parsedAcp(acp: Record<string, unknown>): Record<string, unknown> {
  return nymbalConfigSchema.parse({ ...baseConfig(), agents: { acp } }).agents.acp as Record<
    string,
    unknown
  >
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const alnum = (min: number, max: number) =>
  fc
    .array(fc.constantFrom(...ALNUM.split('')), { minLength: min, maxLength: max })
    .map((cs) => cs.join(''))

const validName = fc.stringMatching(NAME_RULE)
/** Keys the store takes: 32 to 64 characters, marked so no message can hold one by chance. */
const validKey = alnum(28, 60).map((s) => `sk-${s}-`)

/** Entries with pairwise distinct names and keys. */
const distinctEntries = fc
  .uniqueArray(fc.record({ name: validName, key: validKey }), {
    selector: (e) => e.name,
    maxLength: 6,
  })
  .filter((entries) => new Set(entries.map((e) => e.key)).size === entries.length)

/**
 * A name the rule refuses, long enough that a message holding it is an echo, not chance: an upper-case letter, a
 * space or a colon among valid characters, a leading separator, or 41 valid characters.
 */
const refusedName = fc.oneof(
  fc
    .tuple(alnum(3, 12), fc.constantFrom('M', 'Q', ' ', ':'), alnum(3, 12))
    .map(([a, bad, b]) => `${a.toLowerCase()}${bad}${b.toLowerCase()}`),
  alnum(6, 20).map((s) => `-${s.toLowerCase()}`),
  alnum(41, 41).map((s) => s.toLowerCase()),
)

describe('AC-1: agents.acp.keys in the config', () => {
  // Kills: an entry dropped, reordered or rewritten; an absent list parsed as [] (which changes every parsed config).
  it('AC-1: property: a list of entries with names in the rule, keys of at least 32 characters and no name or key twice is kept as given; without keys, agents.acp parses to { enabled, links } with no keys property', () => {
    fc.assert(
      fc.property(fc.option(distinctEntries, { nil: undefined }), fc.boolean(), (keys, enabled) => {
        const acp = parsedAcp({ enabled, ...(keys !== undefined && { keys }) })

        expect(acp).toEqual(
          keys === undefined ? { enabled, links: [] } : { enabled, links: [], keys },
        )
        expect('keys' in acp).toBe(keys !== undefined)
      }),
      { numRuns: 200 },
    )
  })

  // Kills: a name that cannot be an order source label accepted (`agent:Muse Bot`); a refusal that echoes what was
  // typed, so a key pasted into the name field reaches a terminal or CI log; a refusal that does not say the rule.
  it('AC-1: property: a name outside the rule (an upper-case letter, a space, a colon, a leading "-", 41 characters, empty) is refused at agents.acp.keys.<i>.name with a message naming the rule and not containing the name', () => {
    fc.assert(
      fc.property(
        distinctEntries,
        fc.oneof(refusedName, fc.constant('')),
        fc.nat(),
        validKey,
        (good, bad, at, key) => {
          const index = at % (good.length + 1)
          const fresh = `${key}x`
          const keys = [...good.slice(0, index), { name: bad, key: fresh }, ...good.slice(index)]

          const issues = issuesOf({ enabled: true, keys })

          expect(pathsOf(issues)).toEqual([`agents.acp.keys.${index}.name`])
          expect(issues.some((i) => i.message.includes(NAME_RULE.source))).toBe(true)
          // An empty name is in every string, so only a non-empty one can be echoed.
          expect(issues.filter((i) => bad !== '' && i.message.includes(bad))).toEqual([])
        },
      ),
      { numRuns: 300 },
    )
  })

  // Kills: a short key accepted; the bound off by one either way; a refusal that prints the key.
  it('AC-1: property: a key is refused at agents.acp.keys.<i>.key exactly when it is shorter than 32 characters, and the refusal does not contain it', () => {
    fc.assert(
      fc.property(distinctEntries, alnum(8, 48), fc.nat(), (good, key, at) => {
        fc.pre(good.every((e) => e.key !== key && e.name !== 'probe-entry'))
        const index = at % (good.length + 1)
        const keys = [...good.slice(0, index), { name: 'probe-entry', key }, ...good.slice(index)]

        const issues = issuesOf({ enabled: true, keys })

        expect(pathsOf(issues)).toEqual(key.length < 32 ? [`agents.acp.keys.${index}.key`] : [])
        for (const issue of issues) expect(issue.message).not.toContain(key)
      }),
      { numRuns: 300 },
    )
    expect(issuesOf({ keys: [{ name: 'muse', key: 'k'.repeat(31) }] }).map((i) => i.path)).toEqual([
      'agents.acp.keys.0.key',
    ])
    expect(issuesOf({ keys: [{ name: 'muse', key: 'k'.repeat(32) }] })).toEqual([])
  })

  // Kills: an entry that is not strict, so a typo such as `nmae` or a stray `apiKey` is silently dropped.
  it('AC-1: an unknown field in an entry is refused at that entry, naming the field', () => {
    const issues = issuesOf({
      enabled: true,
      keys: [
        { name: 'muse', key: 'k'.repeat(32) },
        { name: 'dots', key: 'd'.repeat(32), label: 'Dots' },
      ],
    })

    expect(issues.map((i) => i.path)).toEqual(['agents.acp.keys.1'])
    expect(issues[0]?.message).toMatch(/label/)
  })

  // Kills: apiKey still configuring a key, or refused without saying where the key goes now, or echoing the value.
  it('AC-1: agents.acp.apiKey with any value (a 32-character string, a short one, a number), with or without keys, is refused at agents.acp.apiKey with a message naming agents.acp.keys and not containing the value', () => {
    const values: unknown[] = ['k9'.repeat(16), 'short-acp-key-77', 4_815_162_342]
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...values), validKey, fc.integer({ min: 1_000_000 })),
        fc.option(distinctEntries, { nil: undefined }),
        (apiKey, keys) => {
          const issues = issuesOf({
            enabled: true,
            apiKey,
            ...(keys !== undefined && { keys }),
          })

          expect(issues.map((i) => i.path)).toEqual(['agents.acp.apiKey'])
          expect(issues[0]?.message).toContain('agents.acp.keys')
          expect(issues[0]?.message).not.toContain(String(apiKey))
        },
      ),
      { numRuns: 200 },
    )
  })
})

/** Entries drawn from small pools, so names and keys repeat often. */
const pooled = fc
  .tuple(
    fc.uniqueArray(validName, { minLength: 3, maxLength: 3 }),
    fc.uniqueArray(validKey, { minLength: 3, maxLength: 3 }),
  )
  .chain(([names, keys]) =>
    fc.record({
      names: fc.constant(names),
      keys: fc.constant(keys),
      entries: fc.array(
        fc.record({ name: fc.constantFrom(...names), key: fc.constantFrom(...keys) }),
        { maxLength: 6 },
      ),
    }),
  )

describe('AC-2: no name or key twice', () => {
  // Kills: two assistants sharing one key (its label ambiguous, revoking one revokes both); one name labelling two
  // keys; a refusal at the wrong entry or not naming the first; a refusal that prints a secret.
  it('AC-2: property: over generated lists the config is refused iff two entries share a name or a key; each refusal is at the later entry’s name or key and names an earlier entry with the same value (a key’s, by its path and name); no message contains any key', () => {
    fc.assert(
      fc.property(pooled, ({ entries, keys }) => {
        const expected = new Set<string>()
        entries.forEach((e, j) => {
          if (entries.slice(0, j).some((o) => o.name === e.name))
            expected.add(`agents.acp.keys.${j}.name`)
          if (entries.slice(0, j).some((o) => o.key === e.key))
            expected.add(`agents.acp.keys.${j}.key`)
        })

        const issues = issuesOf({ enabled: true, keys: entries })

        expect(new Set(issues.map((i) => i.path))).toEqual(expected)
        for (const issue of issues) {
          const [, j, field] = /^agents\.acp\.keys\.(\d+)\.(name|key)$/.exec(issue.path) ?? []
          const later = entries[Number(j)]!
          const earlier = entries
            .map((o, i) => ({ ...o, i }))
            .slice(0, Number(j))
            .filter((o) => (field === 'name' ? o.name === later.name : o.key === later.key))
          expect(
            earlier.some(
              (o) =>
                issue.message.includes(`agents.acp.keys.${o.i}`) &&
                (field === 'name' || issue.message.includes(o.name)),
            ),
            `${issue.path}: ${issue.message}`,
          ).toBe(true)
          for (const key of keys) expect(issue.message).not.toContain(key)
        }
      }),
      { numRuns: 400 },
    )
  })
})
