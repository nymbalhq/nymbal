import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CRAWLERS } from './index.js'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

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

    expect(parsed.agents.mcp).toEqual({ enabled: true, writes: 'proposal' })
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
        expect(parsed.agents.mcp).toEqual({ enabled: true, writes: 'proposal' })
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
  it('AC-1: a config with no agents block parses to ucp enabled with no links and every crawl file on, allowing the named crawlers and others, beside the unchanged mcp defaults', () => {
    const parsed = nymbalConfigSchema.parse(baseConfig())

    expect(parsed.agents).toEqual({
      mcp: { enabled: true, writes: 'proposal' },
      autoApprove: [],
      ucp: { enabled: true, links: [] },
      crawl: {
        robots: true,
        llms: true,
        feed: true,
        allow: [...DEFAULT_AGENT_CRAWLERS],
        others: 'allow',
      },
      assistant: { customerData: true },
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
          expect(parsed.agents.mcp).toEqual({ enabled: true, writes: 'proposal' })
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
