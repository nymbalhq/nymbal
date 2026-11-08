import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ACP_LINK_TYPES,
  ASSISTANT_MASK_FIELDS,
  CUSTOMER_FIELDS,
  DEFAULT_AGENT_CRAWLERS,
  DEFAULT_ASSISTANT_MASK,
  DEFAULT_CUSTOMER_FIELDS,
} from './index.js'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

/** The customer fields agents.mcp.withhold holds when a config leaves it out. */
const WITHHELD_BY_DEFAULT = ['email', 'phone', 'address', 'postcode']

// AC-12: the `agents` block. A store that never mentions agents serves MCP with writes held as proposals; `writes`
// takes `proposal` or `apply` and nothing else. AC-11: `autoApprove` lists the commands a policy approves at the call,
// none by default.

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

const WRITES = ['proposal', 'apply'] as const

describe('AC-12: agents.mcp in the config', () => {
  it('AC-12: a config with no agents block parses to agents.mcp enabled with writes proposal', () => {
    const parsed = nymbalConfigSchema.parse(baseConfig())

    expect(parsed.agents.mcp).toEqual({
      enabled: true,
      writes: 'proposal',
      withhold: WITHHELD_BY_DEFAULT,
    })
  })

  it('AC-12: property: whatever part of agents.mcp a config sets is kept, and every part it leaves out takes its default', () => {
    fc.assert(
      fc.property(
        fc.option(fc.boolean(), { nil: undefined }),
        fc.option(fc.constantFrom(...WRITES), { nil: undefined }),
        (enabled, writes) => {
          const mcp = {
            ...(enabled !== undefined && { enabled }),
            ...(writes !== undefined && { writes }),
          }
          const parsed = nymbalConfigSchema.parse({ ...baseConfig(), agents: { mcp } })

          expect(parsed.agents.mcp).toEqual({
            enabled: enabled ?? true,
            writes: writes ?? 'proposal',
            withhold: WITHHELD_BY_DEFAULT,
          })
        },
      ),
    )
  })

  it('AC-12: property: any writes other than proposal or apply is refused at agents.mcp.writes with a message naming both', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('always'),
          fc.string().filter((s) => !(WRITES as readonly string[]).includes(s)),
        ),
        (writes) => {
          const result = nymbalConfigSchema.safeParse({
            ...baseConfig(),
            agents: { mcp: { writes } },
          })
          const issue = result.success
            ? undefined
            : result.error.issues.find((i) => i.path.join('.') === 'agents.mcp.writes')

          expect(result.success).toBe(false)
          expect(issue?.message).toMatch(/proposal/)
          expect(issue?.message).toMatch(/apply/)
        },
      ),
    )
  })
})

describe('AC-11: agents.autoApprove in the config', () => {
  it('AC-11: a config with no agents block, or an agents block without autoApprove, parses to agents.autoApprove []', () => {
    const bare = nymbalConfigSchema.parse(baseConfig())
    const withMcp = nymbalConfigSchema.parse({
      ...baseConfig(),
      agents: { mcp: { writes: 'apply' } },
    })

    expect([bare.agents.autoApprove, withMcp.agents.autoApprove]).toEqual([[], []])
  })

  it('AC-11: property: any list of non-empty command names is kept as given, beside agents.mcp at its defaults', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { maxLength: 6 }), (autoApprove) => {
        const parsed = nymbalConfigSchema.parse({ ...baseConfig(), agents: { autoApprove } })

        expect(parsed.agents.autoApprove).toEqual(autoApprove)
        expect(parsed.agents.mcp).toEqual({
          enabled: true,
          writes: 'proposal',
          withhold: WITHHELD_BY_DEFAULT,
        })
      }),
    )
  })

  it('AC-11: property: an empty command name is refused at agents.autoApprove.<its index>', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { maxLength: 4 }),
        fc.nat(),
        (names, at) => {
          const index = at % (names.length + 1)
          const autoApprove = [...names.slice(0, index), '', ...names.slice(index)]
          const result = nymbalConfigSchema.safeParse({ ...baseConfig(), agents: { autoApprove } })
          const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'))

          expect(result.success).toBe(false)
          expect(paths).toContain(`agents.autoApprove.${index}`)
        },
      ),
    )
  })
})

// AC-1: `agents.ucp` and `agents.crawl`, beside `agents.mcp`. A store that never mentions them serves the UCP surface
// and every crawl file, allowing the named AI crawlers and everyone else.

/** The crawler names the defaults may hold: each is one its vendor documents, so the list may shrink, never grow. */
const NAMED_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
]

/** Each issue of a refused config as `<path>: <message>`, the form a config error is read in. */
function refusals(agents: unknown): string[] {
  const result = nymbalConfigSchema.safeParse({ ...baseConfig(), agents })
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
}

const crawlerName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,20}$/)
const link = fc.record(
  {
    type: fc.constantFrom('privacy_policy', 'terms_of_service', 'refund_policy', 'faq'),
    url: fc.webUrl(),
    title: fc.string({ maxLength: 40 }),
  },
  { requiredKeys: ['type', 'url'] },
)

describe('AC-1: agents.ucp and agents.crawl in the config', () => {
  it('AC-1: a config with no agents block parses to ucp enabled with no links, acp off with no links and every crawl file on, allowing the named crawlers and others, beside the unchanged mcp defaults', () => {
    const parsed = nymbalConfigSchema.parse(baseConfig())

    expect(parsed.agents).toEqual({
      mcp: { enabled: true, writes: 'proposal', withhold: WITHHELD_BY_DEFAULT },
      autoApprove: [],
      ucp: { enabled: true, links: [] },
      acp: { enabled: false, links: [] },
      crawl: {
        robots: true,
        llms: true,
        feed: true,
        allow: [...DEFAULT_AGENT_CRAWLERS],
        others: 'allow',
      },
      assistant: { customerData: true, mask: ['email', 'phone', 'address', 'postcode'] },
    })
    expect(DEFAULT_AGENT_CRAWLERS.length).toBeGreaterThan(0)
    expect(NAMED_CRAWLERS).toEqual(expect.arrayContaining([...DEFAULT_AGENT_CRAWLERS]))
  })

  it('AC-1: a links entry whose url is not a URL, others maybe, and an unknown key under either block are each refused at the field they name', () => {
    expect(refusals({ ucp: { links: [{ type: 'privacy_policy', url: 'not a url' }] } })).toEqual([
      expect.stringMatching(/^agents\.ucp\.links\.0\.url: /),
    ])
    expect(refusals({ crawl: { others: 'maybe' } })).toEqual([
      expect.stringMatching(/^agents\.crawl\.others: /),
    ])
    expect(refusals({ ucp: { enabeld: false } })).toEqual([
      expect.stringMatching(/^agents\.ucp: .*enabeld/),
    ])
    expect(refusals({ crawl: { robot: false } })).toEqual([
      expect.stringMatching(/^agents\.crawl: .*robot/),
    ])
    expect(refusals({ ucp: { links: [] }, crawl: { others: 'disallow' } })).toEqual([])
  })

  it('AC-1: property: whatever part of agents.ucp and agents.crawl a config sets is kept, and every part it leaves out takes its default', () => {
    const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined })
    fc.assert(
      fc.property(
        fc.record({
          enabled: optional(fc.boolean()),
          links: optional(fc.array(link, { maxLength: 3 })),
        }),
        fc.record({
          robots: optional(fc.boolean()),
          llms: optional(fc.boolean()),
          feed: optional(fc.boolean()),
          allow: optional(fc.array(crawlerName, { maxLength: 5 })),
          others: optional(fc.constantFrom('allow' as const, 'disallow' as const)),
        }),
        (ucpSet, crawlSet) => {
          const given = <T extends Record<string, unknown>>(part: T) =>
            Object.fromEntries(Object.entries(part).filter(([, value]) => value !== undefined))
          const parsed = nymbalConfigSchema.parse({
            ...baseConfig(),
            agents: { ucp: given(ucpSet), crawl: given(crawlSet) },
          })

          expect(parsed.agents.ucp).toEqual({
            enabled: ucpSet.enabled ?? true,
            links: ucpSet.links ?? [],
          })
          expect(parsed.agents.crawl).toEqual({
            robots: crawlSet.robots ?? true,
            llms: crawlSet.llms ?? true,
            feed: crawlSet.feed ?? true,
            allow: crawlSet.allow ?? [...DEFAULT_AGENT_CRAWLERS],
            others: crawlSet.others ?? 'allow',
          })
          expect(parsed.agents.mcp).toEqual({
            enabled: true,
            writes: 'proposal',
            withhold: WITHHELD_BY_DEFAULT,
          })
        },
      ),
    )
  })
})

// AC-1: `agents.acp`, beside the other agents blocks: off unless a store turns it on, a key of at least 32 characters
// when one is given, links only of the types ACP's Link names, and nothing else.

/** The link types the pinned ACP 2026-04-17 schema's `Link` allows. */
function pinnedLinkTypes(): string[] {
  const schema = JSON.parse(
    readFileSync(
      new URL(
        '../../../tests/fixtures/acp/2026-04-17/schema.agentic_checkout.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { $defs: { Link: { properties: { type: { enum: string[] } } } } }
  return schema.$defs.Link.properties.type.enum
}

const acpKey = fc.string({ minLength: 32, maxLength: 64 })

describe('AC-1: agents.acp in the config', () => {
  // Kills: the config's link types drifting from the protocol's.
  it("AC-1: ACP_LINK_TYPES are exactly the link types of the pinned ACP schema's Link", () => {
    expect([...ACP_LINK_TYPES].sort()).toEqual(pinnedLinkTypes().sort())
  })

  // Kills: a short key accepted; an off-protocol link type accepted; an unknown key stripped instead of refused.
  it('AC-1: an apiKey of 31 characters, a link type outside ACP_LINK_TYPES, a link url that is not a URL and an unknown key are each refused at the field they name; a 32-character key and a link of each allowed type are accepted', () => {
    expect(refusals({ acp: { apiKey: 'k'.repeat(31) } })).toEqual([
      expect.stringMatching(/^agents\.acp\.apiKey: /),
    ])
    expect(
      refusals({ acp: { links: [{ type: 'refund_policy', url: 'https://x.example/r' }] } }),
    ).toEqual([expect.stringMatching(/^agents\.acp\.links\.0\.type: /)])
    expect(refusals({ acp: { links: [{ type: 'terms_of_use', url: 'not a url' }] } })).toEqual([
      expect.stringMatching(/^agents\.acp\.links\.0\.url: /),
    ])
    expect(refusals({ acp: { enabeld: true } })).toEqual([
      expect.stringMatching(/^agents\.acp: .*enabeld/),
    ])
    expect(
      refusals({
        acp: {
          enabled: true,
          apiKey: 'k'.repeat(32),
          links: ACP_LINK_TYPES.map((type: string) => ({
            type,
            url: `https://shop.example/${type}`,
          })),
        },
      }),
    ).toEqual([])
  })

  // Kills: the length bound off by one on either side.
  it('AC-1: property: an apiKey is refused at agents.acp.apiKey exactly when it is shorter than 32 characters', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (apiKey) => {
        const refused = refusals({ acp: { apiKey } }).some((r) =>
          r.startsWith('agents.acp.apiKey: '),
        )

        expect(refused).toBe(apiKey.length < 32)
      }),
    )
  })

  // Kills: ACP on by default; a set part dropped; a part left out not given its default; the other blocks disturbed.
  it('AC-1: property: whatever part of agents.acp a config sets is kept, and every part it leaves out takes its default, beside the other agents blocks at theirs', () => {
    const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined })
    const acpLink = fc.record(
      {
        type: fc.constantFrom(...ACP_LINK_TYPES),
        url: fc.webUrl(),
        title: fc.string({ maxLength: 40 }),
      },
      { requiredKeys: ['type', 'url'] },
    )
    fc.assert(
      fc.property(
        fc.record({
          enabled: optional(fc.boolean()),
          apiKey: optional(acpKey),
          links: optional(fc.array(acpLink, { maxLength: 3 })),
          merchantId: optional(fc.string({ minLength: 1, maxLength: 30 })),
        }),
        (set) => {
          const given = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined))
          const parsed = nymbalConfigSchema.parse({ ...baseConfig(), agents: { acp: given } })
          const bare = nymbalConfigSchema.parse(baseConfig())

          expect(parsed.agents.acp).toEqual({
            enabled: set.enabled ?? false,
            links: set.links ?? [],
            ...(set.apiKey !== undefined && { apiKey: set.apiKey }),
            ...(set.merchantId !== undefined && { merchantId: set.merchantId }),
          })
          expect({ ...parsed.agents, acp: undefined }).toEqual({ ...bare.agents, acp: undefined })
        },
      ),
    )
  })
})

describe('AC-20: agents.assistant.customerData in the config', () => {
  it('AC-20: property: agents.assistant.customerData keeps any boolean a config sets and is true when the value or the whole block is left out; a non-boolean value and an unknown key in agents.assistant are refused at the field they name', () => {
    fc.assert(
      fc.property(fc.option(fc.boolean(), { nil: undefined }), fc.boolean(), (set, withBlock) => {
        const agents =
          set !== undefined
            ? { assistant: { customerData: set } }
            : withBlock
              ? { assistant: {} }
              : {}
        const parsed = nymbalConfigSchema.parse({ ...baseConfig(), agents } as NymbalConfigInput)

        expect((parsed.agents as { assistant?: unknown }).assistant).toEqual({
          customerData: set ?? true,
          mask: ['email', 'phone', 'address', 'postcode'],
        })
      }),
    )
    expect(refusals({ assistant: { customerData: 'no' } })).toEqual([
      expect.stringMatching(/^agents\.assistant\.customerData: /),
    ])
    expect(refusals({ assistant: { customerdata: false } })).toEqual([
      expect.stringMatching(/^agents\.assistant: .*customerdata/),
    ])
  })
})

describe('AC-10: agents.assistant.mask in the config', () => {
  const FIVE = ['email', 'phone', 'address', 'postcode', 'name'] as const
  const DEFAULT = ['email', 'phone', 'address', 'postcode']

  const assistantOf = (agents: unknown) =>
    (
      nymbalConfigSchema.parse({ ...baseConfig(), agents } as NymbalConfigInput).agents as {
        assistant?: { customerData?: unknown; mask?: unknown }
      }
    ).assistant

  it('AC-10: a config with no agents block, with an empty assistant block, or with customerData alone parses mask to email, phone, address and postcode, which are DEFAULT_ASSISTANT_MASK, out of the five ASSISTANT_MASK_FIELDS', () => {
    expect(
      [{}, { assistant: {} }, { assistant: { customerData: false } }].map(
        (a) => assistantOf(a)?.mask,
      ),
    ).toEqual([DEFAULT, DEFAULT, DEFAULT])
    expect([...DEFAULT_ASSISTANT_MASK]).toEqual(DEFAULT)
    expect([...ASSISTANT_MASK_FIELDS]).toEqual([...FIVE])
  })

  it('AC-10: property: any list of the five fields, in any order and with repeats, [] included, parses to each field once in the order first given, with customerData kept beside it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...FIVE), { maxLength: 10 }),
        fc.option(fc.boolean(), { nil: undefined }),
        (mask, customerData) => {
          const parsed = assistantOf({
            assistant: { mask, ...(customerData !== undefined && { customerData }) },
          })

          expect(parsed?.mask).toEqual([...new Set(mask)])
          expect(parsed?.customerData).toBe(customerData ?? true)
        },
      ),
    )
    expect(assistantOf({ assistant: { mask: ['email', 'phone', 'email'] } })?.mask).toEqual([
      'email',
      'phone',
    ])
  })

  it('AC-10: property: a field outside the five is refused at agents.assistant.mask.<its index>', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...FIVE), { maxLength: 5 }),
        fc.constantFrom('Email', 'city', 'names', 'address1', 'zip', ''),
        fc.nat(),
        (good, bad, at) => {
          const index = at % (good.length + 1)
          const mask = [...good.slice(0, index), bad, ...good.slice(index)]

          expect(refusals({ assistant: { mask } })).toEqual([
            expect.stringMatching(new RegExp(`^agents\\.assistant\\.mask\\.${index}: `)),
          ])
        },
      ),
    )
  })
})

// AC-5: `agents.mcp.withhold`, the customer fields an admin's MCP client never receives. It shares its five fields and
// its default with `agents.assistant.mask`, so the store's two AI surfaces make one statement about what leaves it.

describe('AC-5: agents.mcp.withhold in the config', () => {
  const FIVE = ['email', 'phone', 'address', 'postcode', 'name'] as const

  const mcpOf = (agents: unknown) =>
    (
      nymbalConfigSchema.parse({ ...baseConfig(), agents } as NymbalConfigInput).agents as {
        mcp?: { withhold?: unknown }
      }
    ).mcp

  it('AC-5: withhold is email, phone, address and postcode when the key, the mcp block or the whole agents block is left out; those are DEFAULT_CUSTOMER_FIELDS out of the five CUSTOMER_FIELDS, which the assistant mask’s constants are', () => {
    const left = [
      nymbalConfigSchema.parse(baseConfig()).agents as { mcp?: { withhold?: unknown } },
      { mcp: mcpOf({ autoApprove: [] }) },
      { mcp: mcpOf({ mcp: { writes: 'apply' } }) },
    ].map((agents) => agents.mcp?.withhold)

    expect(left).toEqual([WITHHELD_BY_DEFAULT, WITHHELD_BY_DEFAULT, WITHHELD_BY_DEFAULT])
    expect([...DEFAULT_CUSTOMER_FIELDS]).toEqual(WITHHELD_BY_DEFAULT)
    expect([...CUSTOMER_FIELDS]).toEqual([...FIVE])
    expect(ASSISTANT_MASK_FIELDS).toBe(CUSTOMER_FIELDS)
    expect(DEFAULT_ASSISTANT_MASK).toBe(DEFAULT_CUSTOMER_FIELDS)
  })

  it('AC-5: property: any list of the five fields, in any order and with repeats, [] included, parses to each field once in the order first given, beside enabled and writes as set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...FIVE), { maxLength: 10 }),
        fc.option(fc.constantFrom(...WRITES), { nil: undefined }),
        (withhold, writes) => {
          const mcp = mcpOf({ mcp: { withhold, ...(writes !== undefined && { writes }) } })

          expect(mcp).toEqual({
            enabled: true,
            writes: writes ?? 'proposal',
            withhold: [...new Set(withhold)],
          })
        },
      ),
    )
  })

  it('AC-5: property: a field outside the five is refused at agents.mcp.withhold.<its index>', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...FIVE), { maxLength: 5 }),
        fc.constantFrom('Email', 'city', 'names', 'address1', 'zip', 'company', ''),
        fc.nat(),
        (good, bad, at) => {
          const index = at % (good.length + 1)
          const withhold = [...good.slice(0, index), bad, ...good.slice(index)]

          expect(refusals({ mcp: { withhold } })).toEqual([
            expect.stringMatching(new RegExp(`^agents\\.mcp\\.withhold\\.${index}: `)),
          ])
        },
      ),
    )
  })

  // Kills: the two surfaces' defaults drifting apart, one changed and not the other.
  it('AC-5: property: for any config that sets neither agents.mcp.withhold nor agents.assistant.mask, whatever else of agents.mcp and agents.assistant it sets, the two parse to the same fields, and those are DEFAULT_CUSTOMER_FIELDS', () => {
    fc.assert(
      fc.property(
        fc.option(fc.boolean(), { nil: undefined }),
        fc.option(fc.constantFrom(...WRITES), { nil: undefined }),
        fc.option(fc.boolean(), { nil: undefined }),
        (enabled, writes, customerData) => {
          const agents = nymbalConfigSchema.parse({
            ...baseConfig(),
            agents: {
              mcp: {
                ...(enabled !== undefined && { enabled }),
                ...(writes !== undefined && { writes }),
              },
              assistant: { ...(customerData !== undefined && { customerData }) },
            },
          }).agents as { mcp: { withhold?: unknown }; assistant: { mask?: unknown } }

          expect(agents.mcp.withhold).toEqual(agents.assistant.mask)
          expect(agents.mcp.withhold).toEqual([...DEFAULT_CUSTOMER_FIELDS])
        },
      ),
    )
  })
})
